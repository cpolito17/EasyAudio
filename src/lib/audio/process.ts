/**
 * Sample-domain processing: gain, true-peak limiting, silence trimming, fades.
 *
 * Everything here operates on plain Float32Array channels so it is independent
 * of both the source container and the output encoder.
 */

import { truePeakLinear } from './loudness.ts';

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY;
}

/** Apply a constant gain in place. */
export function applyGain(channels: Float32Array[], db: number): void {
  if (db === 0) return;
  const factor = dbToLinear(db);
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) channel[i] *= factor;
  }
}

/**
 * A look-ahead true-peak limiter.
 *
 * Normalizing a quiet track upward will push its peaks past full scale. The
 * honest options are to turn the whole track down (losing the loudness target)
 * or to hold the peaks back only where they actually exceed the ceiling. This
 * does the latter: it computes a gain envelope that never rises faster than the
 * release time, and smooths it so the reduction is not audible as distortion.
 *
 * Look-ahead matters because a limiter that reacts only once a peak has arrived
 * has already let it through.
 */
export function limitTruePeak(
  channels: Float32Array[],
  sampleRate: number,
  ceilingDb: number,
): { gainReductionDb: number } {
  const ceiling = dbToLinear(ceilingDb);
  const length = channels[0]?.length ?? 0;
  if (length === 0) return { gainReductionDb: 0 };

  const lookAhead = Math.max(1, Math.round(0.005 * sampleRate)); // 5 ms
  const release = Math.max(1, Math.round(0.05 * sampleRate)); // 50 ms

  // Required gain per sample, taking the loudest channel at each instant.
  const required = new Float32Array(length);
  required.fill(1);

  let anyReduction = false;
  for (let i = 0; i < length; i++) {
    let magnitude = 0;
    for (const channel of channels) {
      const value = Math.abs(channel[i]);
      if (value > magnitude) magnitude = value;
    }
    if (magnitude > ceiling) {
      required[i] = ceiling / magnitude;
      anyReduction = true;
    }
  }

  if (!anyReduction) return { gainReductionDb: 0 };

  // Spread each reduction backwards over the look-ahead window so the gain is
  // already down by the time the peak arrives. This is a forward-looking
  // sliding-window minimum, computed with a monotonic deque so the cost is
  // linear in the track length rather than length times window size.
  const envelope = new Float32Array(length);
  const deque = new Int32Array(length);
  let head = 0;
  let tail = 0;

  for (let i = length - 1; i >= 0; i--) {
    // Drop entries that can never be the minimum again.
    while (tail > head && required[deque[tail - 1]] >= required[i]) tail--;
    deque[tail++] = i;
    // Drop entries that have fallen out of the look-ahead window.
    while (deque[head] > i + lookAhead) head++;
    envelope[i] = required[deque[head]];
  }

  // Release: let the gain return to unity gradually rather than stepping back.
  const releaseCoefficient = Math.exp(-1 / release);
  let current = 1;
  for (let i = 0; i < length; i++) {
    if (envelope[i] < current) {
      current = envelope[i];
    } else {
      current = envelope[i] + (current - envelope[i]) * releaseCoefficient;
    }
    envelope[i] = current;
  }

  let minimumGain = 1;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      channel[i] *= envelope[i];
    }
  }
  for (let i = 0; i < length; i++) {
    if (envelope[i] < minimumGain) minimumGain = envelope[i];
  }

  return { gainReductionDb: linearToDb(minimumGain) };
}

/**
 * Work out the gain that brings `currentLufs` to `targetLufs` without the true
 * peak exceeding `ceilingDb`.
 *
 * Returns both the gain to apply and whether limiting will be needed, so the UI
 * can be honest about which tracks cannot reach the target cleanly.
 */
export function planNormalization(
  currentLufs: number,
  currentTruePeakDb: number,
  targetLufs: number,
  ceilingDb: number,
  preferGainReduction: boolean,
): { gainDb: number; willLimit: boolean; shortfallDb: number } {
  if (!Number.isFinite(currentLufs)) {
    return { gainDb: 0, willLimit: false, shortfallDb: 0 };
  }

  const desiredGain = targetLufs - currentLufs;
  const headroom = ceilingDb - currentTruePeakDb;

  if (desiredGain <= headroom) {
    // Fits without touching the ceiling.
    return { gainDb: desiredGain, willLimit: false, shortfallDb: 0 };
  }

  if (preferGainReduction) {
    // Stay under the ceiling and accept landing quiet of the target.
    return {
      gainDb: headroom,
      willLimit: false,
      shortfallDb: desiredGain - headroom,
    };
  }

  // Hit the target and let the limiter hold the peaks.
  return { gainDb: desiredGain, willLimit: true, shortfallDb: 0 };
}

/** Find where audio actually begins and ends, ignoring near-silence. */
export function detectSilence(
  channels: Float32Array[],
  sampleRate: number,
  thresholdDb = -60,
): { startSeconds: number; endSeconds: number } {
  const threshold = dbToLinear(thresholdDb);
  const length = channels[0]?.length ?? 0;
  if (length === 0) return { startSeconds: 0, endSeconds: 0 };

  const isAudible = (index: number): boolean => {
    for (const channel of channels) {
      if (Math.abs(channel[index]) > threshold) return true;
    }
    return false;
  };

  let first = 0;
  while (first < length && !isAudible(first)) first++;

  let last = length - 1;
  while (last > first && !isAudible(last)) last--;

  return {
    startSeconds: first / sampleRate,
    endSeconds: (length - 1 - last) / sampleRate,
  };
}

/** Return new channels with the given number of seconds removed from each end. */
export function trim(
  channels: Float32Array[],
  sampleRate: number,
  startSeconds: number,
  endSeconds: number,
): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  const start = Math.max(0, Math.round(startSeconds * sampleRate));
  const end = Math.max(start, length - Math.round(endSeconds * sampleRate));
  if (start === 0 && end === length) return channels;
  return channels.map((channel) => channel.slice(start, end));
}

/**
 * Apply fades in place using an equal-power curve.
 *
 * A linear ramp sounds like it dips in the middle because loudness is not
 * linear in amplitude; a sine curve keeps the perceived level even.
 */
export function applyFades(
  channels: Float32Array[],
  sampleRate: number,
  fadeInSeconds: number,
  fadeOutSeconds: number,
): void {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return;

  const fadeIn = Math.min(length, Math.round(fadeInSeconds * sampleRate));
  const fadeOut = Math.min(length - fadeIn, Math.round(fadeOutSeconds * sampleRate));

  for (let i = 0; i < fadeIn; i++) {
    const gain = Math.sin((Math.PI / 2) * (i / fadeIn));
    for (const channel of channels) channel[i] *= gain;
  }

  for (let i = 0; i < fadeOut; i++) {
    const index = length - 1 - i;
    const gain = Math.sin((Math.PI / 2) * (i / fadeOut));
    for (const channel of channels) channel[index] *= gain;
  }
}

/** Measured true peak of the current samples, in dBTP. */
export function measureTruePeakDb(channels: Float32Array[]): number {
  return linearToDb(truePeakLinear(channels));
}

/** Clamp any residual overshoot so the encoder never sees an out-of-range value. */
export function hardClip(channels: Float32Array[]): number {
  let clipped = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      if (channel[i] > 1) {
        channel[i] = 1;
        clipped++;
      } else if (channel[i] < -1) {
        channel[i] = -1;
        clipped++;
      }
    }
  }
  return clipped;
}
