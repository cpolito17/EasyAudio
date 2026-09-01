/**
 * MP3 bitstream parsing and lossless gain adjustment.
 *
 * This is what makes normalization free for MP3 sources. Every Layer III
 * granule carries an 8-bit `global_gain` field, and the decoder scales that
 * granule by 2^((global_gain - 210) / 4). One step is therefore exactly 1.5 dB.
 * Rewriting those bytes changes how loud the file plays without decoding or
 * re-encoding a single sample, so the audio is bit-identical apart from the
 * gain, and the edit is perfectly reversible. This is the same technique
 * mp3gain uses.
 */

export type MpegVersion = 'mpeg1' | 'mpeg2' | 'mpeg2.5';

export interface Mp3Frame {
  /** Byte offset of the frame header within the file. */
  offset: number;
  length: number;
  version: MpegVersion;
  layer: number;
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  /** Bit offsets of each granule's global_gain field, relative to `offset`. */
  globalGainBitOffsets: number[];
  /** True for the Xing/Info/VBRI header frame, which carries no audio. */
  isMetadataFrame: boolean;
}

export interface Mp3Info {
  frames: Mp3Frame[];
  /** Offset of the first frame, i.e. the end of any leading ID3v2 tag. */
  audioStart: number;
  /** Offset just past the last frame, i.e. the start of any trailing tag. */
  audioEnd: number;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  averageBitrateKbps: number;
  isVbr: boolean;
  /** Index into `frames` of the Xing/Info frame, or -1. */
  metadataFrameIndex: number;
}

const BITRATES_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATES_V2_L3 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const SAMPLE_RATES: Record<MpegVersion, number[]> = {
  mpeg1: [44100, 48000, 32000, 0],
  mpeg2: [22050, 24000, 16000, 0],
  'mpeg2.5': [11025, 12000, 8000, 0],
};

/** Size of the Layer III side information block, in bytes. */
function sideInfoSize(version: MpegVersion, channels: number): number {
  if (version === 'mpeg1') return channels === 1 ? 17 : 32;
  return channels === 1 ? 9 : 17;
}

/**
 * Bit positions of every `global_gain` field inside a frame, measured from the
 * first byte of the frame header.
 *
 * The layout is fixed because each granule/channel block in the side info has a
 * constant width: 59 bits under MPEG-1, 63 bits under MPEG-2 and MPEG-2.5. Both
 * figures are verified by the side-info sizes adding up exactly.
 */
function globalGainOffsets(
  version: MpegVersion,
  channels: number,
  hasCrc: boolean,
): number[] {
  const sideInfoStartBits = (4 + (hasCrc ? 2 : 0)) * 8;
  const offsets: number[] = [];

  if (version === 'mpeg1') {
    // main_data_begin(9) + private_bits(5 mono / 3 otherwise) + scfsi(4/channel)
    const base = sideInfoStartBits + 9 + (channels === 1 ? 5 : 3) + 4 * channels;
    const blockBits = 59;
    // Two granules, each with one block per channel.
    for (let index = 0; index < 2 * channels; index++) {
      // part2_3_length(12) + big_values(9) precede global_gain.
      offsets.push(base + index * blockBits + 21);
    }
  } else {
    // main_data_begin(8) + private_bits(1 mono / 2 otherwise). No scfsi.
    const base = sideInfoStartBits + 8 + (channels === 1 ? 1 : 2);
    const blockBits = 63;
    // MPEG-2 and 2.5 carry a single granule.
    for (let channel = 0; channel < channels; channel++) {
      offsets.push(base + channel * blockBits + 21);
    }
  }

  return offsets;
}

/** Parse a frame header at `offset`, or null when it is not a valid frame. */
function parseFrameHeader(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length) return null;

  // Eleven bits of sync.
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layerBits = (bytes[offset + 1] >> 1) & 0x03;
  const hasCrc = (bytes[offset + 1] & 0x01) === 0;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  const channelMode = (bytes[offset + 3] >> 6) & 0x03;

  if (versionBits === 1) return null; // Reserved.
  if (layerBits !== 1) return null; // We only handle Layer III.
  if (bitrateIndex === 0 || bitrateIndex === 15) return null; // Free/bad.
  if (sampleRateIndex === 3) return null;

  const version: MpegVersion =
    versionBits === 3 ? 'mpeg1' : versionBits === 2 ? 'mpeg2' : 'mpeg2.5';

  const bitrateKbps =
    version === 'mpeg1'
      ? BITRATES_V1_L3[bitrateIndex]
      : BITRATES_V2_L3[bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  if (!bitrateKbps || !sampleRate) return null;

  const channels = channelMode === 3 ? 1 : 2;
  const samplesPerFrame = version === 'mpeg1' ? 1152 : 576;

  // Layer III frame length in bytes.
  const length =
    Math.floor((samplesPerFrame / 8) * (bitrateKbps * 1000) / sampleRate) + padding;
  if (length < 4 || offset + length > bytes.length) return null;

  return {
    offset,
    length,
    version,
    layer: 3,
    bitrateKbps,
    sampleRate,
    channels,
    samplesPerFrame,
    globalGainBitOffsets: globalGainOffsets(version, channels, hasCrc),
    isMetadataFrame: isXingFrame(bytes, offset, version, channels, hasCrc),
  };
}

/**
 * The Xing/Info/VBRI header lives in the first frame, after the side info. It
 * decodes as silence and must never be gain-adjusted, or the tag is corrupted.
 */
function isXingFrame(
  bytes: Uint8Array,
  offset: number,
  version: MpegVersion,
  channels: number,
  hasCrc: boolean,
): boolean {
  const tagOffset =
    offset + 4 + (hasCrc ? 2 : 0) + sideInfoSize(version, channels);
  if (tagOffset + 4 > bytes.length) return false;

  const magic = String.fromCharCode(
    bytes[tagOffset],
    bytes[tagOffset + 1],
    bytes[tagOffset + 2],
    bytes[tagOffset + 3],
  );
  if (magic === 'Xing' || magic === 'Info') return true;

  // VBRI sits at a fixed offset of 32 bytes past the header instead.
  const vbriOffset = offset + 4 + 32;
  if (vbriOffset + 4 > bytes.length) return false;
  return (
    String.fromCharCode(
      bytes[vbriOffset],
      bytes[vbriOffset + 1],
      bytes[vbriOffset + 2],
      bytes[vbriOffset + 3],
    ) === 'VBRI'
  );
}

/** Length of a leading ID3v2 tag, or 0 when there is none. */
export function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0; // "ID3"
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const hasFooter = (bytes[5] & 0x10) !== 0;
  return 10 + size + (hasFooter ? 10 : 0);
}

/** Size of trailing ID3v1 / APEv2 metadata that must not be treated as audio. */
function trailingTagSize(bytes: Uint8Array): number {
  let size = 0;

  // ID3v1 is a fixed 128-byte block starting with "TAG".
  if (bytes.length >= 128) {
    const start = bytes.length - 128;
    if (bytes[start] === 0x54 && bytes[start + 1] === 0x41 && bytes[start + 2] === 0x47) {
      size = 128;
    }
  }

  // APEv2 footer: "APETAGEX" plus a little-endian size field.
  const apeEnd = bytes.length - size;
  if (apeEnd >= 32) {
    const start = apeEnd - 32;
    const magic = String.fromCharCode(...bytes.subarray(start, start + 8));
    if (magic === 'APETAGEX') {
      const tagSize =
        bytes[start + 12] |
        (bytes[start + 13] << 8) |
        (bytes[start + 14] << 16) |
        (bytes[start + 15] << 24);
      size += tagSize + 32;
    }
  }

  return size;
}

/**
 * Walk the whole file and index every frame.
 *
 * Returns null when the bytes are not a usable MP3, which is the signal for the
 * caller to fall back to the decode-and-re-encode path.
 */
export function parseMp3(bytes: Uint8Array): Mp3Info | null {
  const audioStart = id3v2Length(bytes);
  const audioEnd = bytes.length - trailingTagSize(bytes);

  const frames: Mp3Frame[] = [];
  let cursor = audioStart;
  let resyncAttempts = 0;

  // Find the first genuine frame. A single valid header can appear by chance in
  // tag padding, so require a second frame to follow immediately.
  while (cursor < audioEnd - 4) {
    const candidate = parseFrameHeader(bytes, cursor);
    if (candidate) {
      const next = parseFrameHeader(bytes, cursor + candidate.length);
      if (next || cursor + candidate.length >= audioEnd) break;
    }
    cursor++;
    if (++resyncAttempts > 128 * 1024) return null;
  }

  while (cursor < audioEnd) {
    const frame = parseFrameHeader(bytes, cursor);
    if (!frame) {
      // Tolerate a small amount of garbage, then give up on the whole file.
      let recovered = false;
      const limit = Math.min(cursor + 8192, audioEnd - 4);
      for (let probe = cursor + 1; probe < limit; probe++) {
        const next = parseFrameHeader(bytes, probe);
        if (next && parseFrameHeader(bytes, probe + next.length)) {
          cursor = probe;
          recovered = true;
          break;
        }
      }
      if (!recovered) break;
      continue;
    }
    frames.push(frame);
    cursor += frame.length;
  }

  if (frames.length === 0) return null;

  const metadataFrameIndex = frames[0].isMetadataFrame ? 0 : -1;
  const audioFrames = metadataFrameIndex === 0 ? frames.slice(1) : frames;
  if (audioFrames.length === 0) return null;

  let totalSamples = 0;
  let totalBytes = 0;
  const bitrates = new Set<number>();
  for (const frame of audioFrames) {
    totalSamples += frame.samplesPerFrame;
    totalBytes += frame.length;
    bitrates.add(frame.bitrateKbps);
  }

  const sampleRate = audioFrames[0].sampleRate;
  const durationSeconds = totalSamples / sampleRate;

  return {
    frames,
    audioStart: frames[0].offset,
    audioEnd: cursor,
    sampleRate,
    channels: audioFrames[0].channels,
    durationSeconds,
    averageBitrateKbps:
      durationSeconds > 0 ? (totalBytes * 8) / durationSeconds / 1000 : 0,
    isVbr: bitrates.size > 1,
    metadataFrameIndex,
  };
}

/** One `global_gain` step, in decibels. */
export const GAIN_STEP_DB = 1.5;

export interface GainApplication {
  /** Steps actually applied. Multiply by GAIN_STEP_DB for the real change. */
  steps: number;
  /** True when the request was reduced to keep every field within 0..255. */
  clamped: boolean;
  /** The gain in dB that was actually applied. */
  appliedDb: number;
}

function readBits(bytes: Uint8Array, bitOffset: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const bit = bitOffset + i;
    const byte = bytes[bit >> 3];
    value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
  }
  return value;
}

function writeBits(
  bytes: Uint8Array,
  bitOffset: number,
  count: number,
  value: number,
): void {
  for (let i = 0; i < count; i++) {
    const bit = bitOffset + i;
    const index = bit >> 3;
    const mask = 1 << (7 - (bit & 7));
    const set = (value >> (count - 1 - i)) & 1;
    bytes[index] = set ? bytes[index] | mask : bytes[index] & ~mask;
  }
}

/**
 * The largest number of steps that can be applied to every audio frame without
 * any `global_gain` field leaving the representable 0..255 range.
 */
export function maxApplicableSteps(
  bytes: Uint8Array,
  info: Mp3Info,
  requestedSteps: number,
): number {
  if (requestedSteps === 0) return 0;

  let headroom = Math.abs(requestedSteps);
  const direction = Math.sign(requestedSteps);

  for (const frame of info.frames) {
    if (frame.isMetadataFrame) continue;
    for (const bitOffset of frame.globalGainBitOffsets) {
      const gain = readBits(bytes, frame.offset * 8 + bitOffset, 8);
      const available = direction > 0 ? 255 - gain : gain;
      if (available < headroom) headroom = available;
      if (headroom === 0) return 0;
    }
  }

  return direction * headroom;
}

/**
 * Apply a gain change losslessly, in place, by rewriting every `global_gain`.
 *
 * `bytes` must be a private copy: this mutates it.
 */
export function applyLosslessGain(
  bytes: Uint8Array,
  info: Mp3Info,
  requestedSteps: number,
): GainApplication {
  const steps = maxApplicableSteps(bytes, info, requestedSteps);

  if (steps !== 0) {
    for (const frame of info.frames) {
      if (frame.isMetadataFrame) continue;
      for (const bitOffset of frame.globalGainBitOffsets) {
        const absolute = frame.offset * 8 + bitOffset;
        const gain = readBits(bytes, absolute, 8);
        writeBits(bytes, absolute, 8, gain + steps);
      }
    }
  }

  return {
    steps,
    clamped: steps !== requestedSteps,
    appliedDb: steps * GAIN_STEP_DB,
  };
}

/**
 * Convert a desired gain in dB to whole `global_gain` steps.
 *
 * Rounding down in magnitude is deliberate: overshooting the target loudness
 * risks clipping, and landing 0.7 dB quiet is always safer than 0.8 dB loud.
 */
export function dbToSteps(db: number): number {
  return Math.trunc(db / GAIN_STEP_DB);
}
