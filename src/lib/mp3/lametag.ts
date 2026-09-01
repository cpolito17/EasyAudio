/**
 * Xing/Info header with the LAME extension.
 *
 * This is what preserves gapless playback. An MP3 encoder cannot represent an
 * arbitrary sample count: it pads the start with priming samples and the end
 * out to a frame boundary. Without a header declaring how many samples to throw
 * away at each end, every decoder inserts a short silence, and a continuously
 * mixed album develops an audible click between every track.
 *
 * lamejs writes no such header, so we build one.
 */

import { ByteWriter } from '../util/bytes.ts';
import { parseMp3 } from './frames.ts';

/**
 * LAME's own encoder delay, in samples. Decoders that honour the tag also add
 * the fixed 529-sample decoder delay on top of this value.
 */
export const ENCODER_DELAY = 576;

/** Side information size for the frame layout we are describing. */
function sideInfoSize(isMpeg1: boolean, channels: number): number {
  if (isMpeg1) return channels === 1 ? 17 : 32;
  return channels === 1 ? 9 : 17;
}

const BITRATE_INDEX_V1: Record<number, number> = {
  32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7, 112: 8,
  128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14,
};
const SAMPLE_RATE_INDEX: Record<number, number> = { 44100: 0, 48000: 1, 32000: 2 };

export interface LameTagOptions {
  sampleRate: number;
  channels: number;
  /** Number of audio frames that follow this header frame. */
  frameCount: number;
  /** Total byte length of the stream including this header frame. */
  byteCount: number;
  /** Samples the decoder should discard from the start. */
  encoderDelay: number;
  /** Samples the decoder should discard from the end. */
  encoderPadding: number;
  /** Optional ReplayGain peak, as a linear ratio. */
  peak?: number;
}

/**
 * Build a complete MP3 frame containing the Info header.
 *
 * "Info" rather than "Xing" marks the stream as constant bitrate, which is what
 * we produce; using the wrong magic makes some players mis-seek.
 */
export function buildLameHeaderFrame(options: LameTagOptions): Uint8Array {
  const {
    sampleRate, channels, frameCount, byteCount,
    encoderDelay, encoderPadding, peak = 0,
  } = options;

  // The header frame is written in the MPEG-1 layout at a safe bitrate so it is
  // always large enough to hold the tag.
  const isMpeg1 = sampleRate >= 32000;
  const headerBitrate = 128;
  const sampleRateIndex = SAMPLE_RATE_INDEX[sampleRate] ?? 0;
  const bitrateIndex = BITRATE_INDEX_V1[headerBitrate] ?? 9;
  const samplesPerFrame = isMpeg1 ? 1152 : 576;

  const frameLength = Math.floor(
    (samplesPerFrame / 8) * (headerBitrate * 1000) / sampleRate,
  );

  const frame = new Uint8Array(frameLength);

  // Frame header. Protection bit set to 1 means "no CRC", which keeps the
  // layout simple and matches what LAME writes for its own header frame.
  frame[0] = 0xff;
  frame[1] = isMpeg1 ? 0xfb : 0xf3;
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2);
  frame[3] = channels === 1 ? 0xc0 : 0x00;

  // Side info stays zero: this frame decodes to silence and is skipped anyway.
  const tagOffset = 4 + sideInfoSize(isMpeg1, channels);

  const writer = new ByteWriter(256);
  writer.ascii('Info');
  // Flags: frames, bytes, TOC and quality are all present.
  writer.u32(0x0000000f);
  writer.u32(frameCount);
  writer.u32(byteCount);

  // A linear seek table is honest for constant bitrate: byte position really is
  // proportional to time, so an interpolated table would add no information.
  for (let i = 0; i < 100; i++) {
    writer.u8(Math.min(255, Math.floor((i * 256) / 100)));
  }
  writer.u32(100); // Quality indicator.

  // LAME extension, 36 bytes.
  writer.ascii('LAME3.100');           // 9 bytes: encoder short version.
  writer.u8(0x00);                     // Tag revision and VBR method (CBR).
  writer.u8(0x00);                     // Lowpass, unknown.

  // ReplayGain peak as a 32-bit float scaled so 1.0 is full scale.
  const peakBytes = new Uint8Array(4);
  new DataView(peakBytes.buffer).setFloat32(0, peak);
  writer.bytes(peakBytes);

  writer.u16(0x0000);                  // Radio replay gain, unset.
  writer.u16(0x0000);                  // Audiophile replay gain, unset.
  writer.u8(0x00);                     // Encoding flags and ATH type.
  writer.u8(headerBitrate);            // Bitrate.

  // Encoder delay and padding, twelve bits each across three bytes. This is the
  // whole reason the header exists.
  const delay = Math.max(0, Math.min(4095, encoderDelay));
  const padding = Math.max(0, Math.min(4095, encoderPadding));
  writer.u8(delay >> 4);
  writer.u8(((delay & 0x0f) << 4) | ((padding >> 8) & 0x0f));
  writer.u8(padding & 0xff);

  writer.u8(0x00);                     // Misc.
  writer.u8(0x00);                     // MP3 gain.
  writer.u16(0x0000);                  // Preset and surround info.
  writer.u32(byteCount);               // Music length.
  writer.u16(0x0000);                  // Music CRC, not computed.
  writer.u16(0x0000);                  // Tag CRC, not computed.

  const tag = writer.finish();
  if (tagOffset + tag.length > frame.length) {
    // Should be impossible at 128 kbps, but silently truncating the tag would
    // produce a file that looks fine and seeks wrongly.
    throw new Error('Info header does not fit in a single frame.');
  }
  frame.set(tag, tagOffset);

  return frame;
}

/**
 * Prepend an Info header to a freshly encoded stream.
 *
 * `sourceSampleCount` is the number of samples that actually went in, which is
 * what lets us work out how much padding the encoder added at the end.
 */
export function addLameHeader(
  encoded: Uint8Array,
  sampleRate: number,
  channels: number,
  sourceSampleCount: number,
  peak?: number,
): Uint8Array {
  const info = parseMp3(encoded);
  if (!info) return encoded;

  const audioFrames = info.frames.filter((frame) => !frame.isMetadataFrame);
  const encodedSamples = audioFrames.reduce(
    (total, frame) => total + frame.samplesPerFrame,
    0,
  );

  // Everything the encoder produced beyond the priming samples and the real
  // audio is trailing padding.
  const padding = Math.max(0, encodedSamples - ENCODER_DELAY - sourceSampleCount);

  // The byte count in the header covers the whole stream, this frame included,
  // so the header's own size has to be known before it is built.
  const headerFrameLength = Math.floor(
    (1152 / 8) * (128 * 1000) / sampleRate,
  );

  const header = buildLameHeaderFrame({
    sampleRate,
    channels,
    frameCount: audioFrames.length,
    byteCount: encoded.length + headerFrameLength,
    encoderDelay: ENCODER_DELAY,
    encoderPadding: padding,
    peak,
  });

  const out = new Uint8Array(header.length + encoded.length);
  out.set(header, 0);
  out.set(encoded, header.length);
  return out;
}
