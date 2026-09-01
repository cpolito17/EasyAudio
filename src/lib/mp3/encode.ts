/**
 * MP3 encoding for the paths where a lossless gain rewrite is not possible.
 *
 * Re-encoding is always the fallback, never the default: it costs a lossy
 * generation. It is used only when the source is not MP3, or when an edit
 * changes the samples themselves (trimming, fades, limiting).
 */

import { Mp3Encoder } from '@breezystack/lamejs';
import { addLameHeader } from './lametag.ts';

/** lamejs takes 16-bit integers, so float samples have to be quantised. */
function toInt16(channel: Float32Array, start: number, count: number): Int16Array {
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const sample = channel[start + i];
    // Clamp before scaling: a value past full scale would otherwise wrap and
    // turn a loud passage into harsh noise.
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    out[i] = Math.round(clamped * (clamped < 0 ? 32768 : 32767));
  }
  return out;
}

export interface EncodeOptions {
  bitrateKbps: number;
  /** Reported back through the Info header for ReplayGain-aware players. */
  peak?: number;
  /** Called with a 0..1 fraction so long encodes can show progress. */
  onProgress?: (fraction: number) => void;
}

/**
 * Encode decoded samples to a complete MP3 file, gapless metadata included.
 *
 * lamejs accepts only a handful of sample rates. Anything else is resampled by
 * the caller before it reaches here.
 */
export function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  options: EncodeOptions,
): Uint8Array {
  const channelCount = Math.min(2, channels.length);
  const length = channels[0]?.length ?? 0;
  if (length === 0) return new Uint8Array(0);

  const encoder = new Mp3Encoder(channelCount, sampleRate, options.bitrateKbps);
  const chunks: Uint8Array[] = [];

  // 1152 samples is one MPEG-1 Layer III frame, so this aligns the work with
  // the encoder's own block size.
  const blockSize = 1152;

  for (let offset = 0; offset < length; offset += blockSize) {
    const count = Math.min(blockSize, length - offset);
    const left = toInt16(channels[0], offset, count);

    const encoded =
      channelCount === 1
        ? encoder.encodeBuffer(left)
        : encoder.encodeBuffer(left, toInt16(channels[1], offset, count));

    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));

    if (options.onProgress && offset % (blockSize * 64) === 0) {
      options.onProgress(offset / length);
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  let totalSize = 0;
  for (const chunk of chunks) totalSize += chunk.length;

  const encoded = new Uint8Array(totalSize);
  let cursor = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, cursor);
    cursor += chunk.length;
  }

  options.onProgress?.(1);

  // Without this the album loses gapless playback.
  return addLameHeader(encoded, sampleRate, channelCount, length, options.peak);
}

/** Sample rates lamejs supports natively. */
const SUPPORTED_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export function isSupportedSampleRate(rate: number): boolean {
  return SUPPORTED_RATES.includes(rate);
}

/** The rate we should resample to when the source rate cannot be encoded. */
export function nearestSupportedRate(rate: number): number {
  // Prefer 44.1k for anything unusual: it is the format's home territory and
  // what every target expects.
  if (rate > 48000) return 48000;
  let best = SUPPORTED_RATES[0];
  let bestDistance = Infinity;
  for (const candidate of SUPPORTED_RATES) {
    const distance = Math.abs(candidate - rate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
