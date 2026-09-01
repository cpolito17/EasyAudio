/**
 * Loudness measurement to ITU-R BS.1770-4 / EBU R128.
 *
 * This is the module the whole normalization feature rests on, so it implements
 * the specification directly rather than approximating it:
 *
 *   - K-weighting via the two prescribed biquad stages, with coefficients
 *     recomputed for the file's real sample rate instead of assuming 48 kHz.
 *   - Gated integrated loudness: 400 ms blocks at 75% overlap, an absolute gate
 *     at -70 LUFS and a relative gate 10 LU below the ungated mean.
 *   - Loudness range per EBU Tech 3342: 3 s windows, a -20 LU relative gate,
 *     and the span between the 10th and 95th percentiles.
 *   - True peak by 4x polyphase oversampling, because a signal can exceed 0 dBTP
 *     while every stored sample sits below full scale.
 */

import type { LoudnessReport } from '../../types.ts';

/** A single direct-form-II transposed biquad section. */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Stage 1 of K-weighting: a high shelf approximating the acoustic effect of a
 * listener's head. Derived from the analog prototype so it tracks sample rate.
 */
function highShelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const denominator = 1 + k / q + k * k;

  return {
    b0: (vh + (vb * k) / q + k * k) / denominator,
    b1: (2 * (k * k - vh)) / denominator,
    b2: (vh - (vb * k) / q + k * k) / denominator,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
}

/** Stage 2: the RLB high-pass that discards sub-bass the ear barely weights. */
function highPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const denominator = 1 + k / q + k * k;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
}

/** Apply a biquad in place. The caller owns the buffer, so this never copies. */
function filterInPlace(samples: Float32Array, coefficients: Biquad): void {
  const { b0, b1, b2, a1, a2 } = coefficients;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    samples[i] = y0;
  }
}

/**
 * BS.1770 channel weights. Stereo and mono weight every channel at 1.0; the
 * surround channels are the only ones that differ, and we handle the common
 * 5.1 ordering so multichannel sources are not silently mismeasured.
 */
function channelWeights(channelCount: number): number[] {
  if (channelCount === 6) {
    // L, R, C, LFE, Ls, Rs. LFE is excluded from the measurement entirely.
    return [1, 1, 1, 0, 1.41, 1.41];
  }
  return new Array(channelCount).fill(1);
}

/** Mean of the values, or -Infinity when the list is empty. */
function mean(values: number[]): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function loudnessFromEnergy(energy: number): number {
  if (energy <= 0) return Number.NEGATIVE_INFINITY;
  return -0.691 + 10 * Math.log10(energy);
}

/**
 * Mean square energy of each overlapping window, already channel-weighted.
 * Returned as raw energy so the gating stages can average in the linear domain,
 * which is what the specification requires.
 */
function windowEnergies(
  weighted: Float32Array[],
  sampleRate: number,
  windowSeconds: number,
  hopSeconds: number,
): number[] {
  const weights = channelWeights(weighted.length);
  const windowSamples = Math.round(windowSeconds * sampleRate);
  const hopSamples = Math.max(1, Math.round(hopSeconds * sampleRate));
  const totalSamples = weighted[0]?.length ?? 0;

  if (totalSamples < windowSamples) return [];

  // Prefix sums of the squares turn every window into two lookups, which keeps
  // a 3 s / 100 ms sweep from re-summing the same samples thirty times over.
  const prefixes: Float64Array[] = weighted.map((channel) => {
    const prefix = new Float64Array(channel.length + 1);
    let running = 0;
    for (let i = 0; i < channel.length; i++) {
      running += channel[i] * channel[i];
      prefix[i + 1] = running;
    }
    return prefix;
  });

  const energies: number[] = [];
  const lastStart = totalSamples - windowSamples;

  for (let start = 0; start <= lastStart; start += hopSamples) {
    const end = start + windowSamples;
    let energy = 0;
    for (let channel = 0; channel < prefixes.length; channel++) {
      const weight = weights[channel];
      if (weight === 0) continue;
      const sumOfSquares = prefixes[channel][end] - prefixes[channel][start];
      energy += weight * (sumOfSquares / windowSamples);
    }
    energies.push(energy);
  }

  return energies;
}

/** Gated integrated loudness, LUFS. */
function integratedLoudness(blockEnergies: number[]): number {
  const ABSOLUTE_GATE = -70;

  const aboveAbsolute = blockEnergies.filter(
    (energy) => loudnessFromEnergy(energy) > ABSOLUTE_GATE,
  );
  if (aboveAbsolute.length === 0) return Number.NEGATIVE_INFINITY;

  // The relative gate sits 10 LU below the mean of everything that cleared the
  // absolute gate, which is what stops long fades from dragging the result down.
  const relativeGate = loudnessFromEnergy(mean(aboveAbsolute)) - 10;

  const gated = aboveAbsolute.filter(
    (energy) => loudnessFromEnergy(energy) > relativeGate,
  );
  if (gated.length === 0) return Number.NEGATIVE_INFINITY;

  return loudnessFromEnergy(mean(gated));
}

/** Loudness range in LU, per EBU Tech 3342. */
function loudnessRange(shortTermEnergies: number[]): number {
  const ABSOLUTE_GATE = -70;

  const aboveAbsolute = shortTermEnergies.filter(
    (energy) => loudnessFromEnergy(energy) > ABSOLUTE_GATE,
  );
  if (aboveAbsolute.length < 2) return 0;

  const relativeGate = loudnessFromEnergy(mean(aboveAbsolute)) - 20;

  const gated = aboveAbsolute
    .filter((energy) => loudnessFromEnergy(energy) > relativeGate)
    .map(loudnessFromEnergy)
    .sort((a, b) => a - b);

  if (gated.length < 2) return 0;

  const percentile = (fraction: number): number => {
    const position = fraction * (gated.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return gated[lower];
    return gated[lower] + (gated[upper] - gated[lower]) * (position - lower);
  };

  return percentile(0.95) - percentile(0.1);
}

/**
 * A 4x polyphase interpolator built from a windowed sinc.
 *
 * Splitting one long low-pass into four branches means each output sample costs
 * only `TAPS_PER_PHASE` multiplies instead of the full filter length.
 */
const PHASES = 4;
const TAPS_PER_PHASE = 12;

const POLYPHASE = (() => {
  const length = PHASES * TAPS_PER_PHASE;
  const prototype = new Float64Array(length);
  const centre = (length - 1) / 2;

  for (let n = 0; n < length; n++) {
    const t = (n - centre) / PHASES;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    // Blackman window keeps the stopband low enough that the interpolation does
    // not itself invent peaks that were never in the signal.
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (length - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (length - 1));
    prototype[n] = sinc * w;
  }

  const branches: Float32Array[] = [];
  for (let phase = 0; phase < PHASES; phase++) {
    const branch = new Float32Array(TAPS_PER_PHASE);
    let sum = 0;
    for (let tap = 0; tap < TAPS_PER_PHASE; tap++) {
      const value = prototype[tap * PHASES + phase];
      branch[tap] = value;
      sum += value;
    }
    // Unity DC gain per branch, so a constant signal interpolates to itself.
    if (sum !== 0) {
      for (let tap = 0; tap < TAPS_PER_PHASE; tap++) branch[tap] /= sum;
    }
    branches.push(branch);
  }
  return branches;
})();

/** Peak of the reconstructed waveform between samples, as a linear magnitude. */
export function truePeakLinear(channels: Float32Array[]): number {
  let peak = 0;

  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      for (let phase = 0; phase < PHASES; phase++) {
        const taps = POLYPHASE[phase];
        let accumulator = 0;
        for (let tap = 0; tap < TAPS_PER_PHASE; tap++) {
          const index = i - tap;
          if (index < 0) break;
          accumulator += taps[tap] * channel[index];
        }
        const magnitude = Math.abs(accumulator);
        if (magnitude > peak) peak = magnitude;
      }
    }
  }

  return peak;
}

/**
 * Crest-based dynamic range, following the offline TT DR meter method: compare
 * the second-highest peak against the RMS of the loudest fifth of 3 s blocks.
 * A low figure means the master is heavily compressed.
 */
function dynamicRange(channels: Float32Array[], sampleRate: number): number {
  const blockSamples = Math.round(3 * sampleRate);
  if ((channels[0]?.length ?? 0) < blockSamples) return 0;

  const perChannel: number[] = [];

  for (const channel of channels) {
    const blockRms: number[] = [];
    for (let start = 0; start + blockSamples <= channel.length; start += blockSamples) {
      let sumOfSquares = 0;
      for (let i = start; i < start + blockSamples; i++) {
        sumOfSquares += channel[i] * channel[i];
      }
      // The TT meter uses a sqrt(2) convention so a full-scale sine reads 0 dB.
      blockRms.push(Math.sqrt((2 * sumOfSquares) / blockSamples));
    }
    if (blockRms.length === 0) continue;

    // Second-highest sample peak, which ignores a single stray transient.
    let highest = 0;
    let secondHighest = 0;
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > highest) {
        secondHighest = highest;
        highest = magnitude;
      } else if (magnitude > secondHighest) {
        secondHighest = magnitude;
      }
    }
    if (secondHighest <= 0) continue;

    blockRms.sort((a, b) => b - a);
    const loudestCount = Math.max(1, Math.round(blockRms.length * 0.2));
    let sumOfSquares = 0;
    for (let i = 0; i < loudestCount; i++) {
      sumOfSquares += blockRms[i] * blockRms[i];
    }
    const upperRms = Math.sqrt(sumOfSquares / loudestCount);
    if (upperRms <= 0) continue;

    perChannel.push(20 * Math.log10(secondHighest / upperRms));
  }

  if (perChannel.length === 0) return 0;
  return mean(perChannel);
}

export interface AnalyzeOptions {
  /** Skip the true-peak sweep when only integrated loudness is needed. */
  includeTruePeak?: boolean;
  includeDynamicRange?: boolean;
}

/**
 * Measure a decoded buffer. The input is not modified: K-weighting runs on
 * private copies so the caller can still export the original samples.
 */
export function analyzeLoudness(
  channels: Float32Array[],
  sampleRate: number,
  options: AnalyzeOptions = {},
): LoudnessReport {
  const { includeTruePeak = true, includeDynamicRange = true } = options;

  if (channels.length === 0 || channels[0].length === 0) {
    return {
      integrated: Number.NEGATIVE_INFINITY,
      range: 0,
      truePeak: Number.NEGATIVE_INFINITY,
      samplePeak: Number.NEGATIVE_INFINITY,
      clippedSamples: 0,
      dynamicRange: 0,
    };
  }

  let samplePeak = 0;
  let clippedSamples = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > samplePeak) samplePeak = magnitude;
      // Decoders reconstruct beyond full scale, so >= 1.0 is the honest test for
      // a source that was already driven into clipping before it reached us.
      if (magnitude >= 1) clippedSamples++;
    }
  }

  const weighted = channels.map((channel) => {
    const copy = new Float32Array(channel);
    filterInPlace(copy, highShelf(sampleRate));
    filterInPlace(copy, highPass(sampleRate));
    return copy;
  });

  const momentary = windowEnergies(weighted, sampleRate, 0.4, 0.1);
  const shortTerm = windowEnergies(weighted, sampleRate, 3, 0.1);

  const truePeak = includeTruePeak ? truePeakLinear(channels) : samplePeak;

  const toDb = (linear: number): number =>
    linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY;

  return {
    integrated: integratedLoudness(momentary),
    range: loudnessRange(shortTerm),
    truePeak: toDb(truePeak),
    samplePeak: toDb(samplePeak),
    clippedSamples,
    dynamicRange: includeDynamicRange ? dynamicRange(channels, sampleRate) : 0,
  };
}

/**
 * Combine per-track measurements into one album figure.
 *
 * Album loudness is an energy-weighted average across the whole release, not a
 * mean of the track values: a 30 second interlude must not pull the album gain
 * as hard as an eight minute closer.
 */
export function albumIntegratedLoudness(
  tracks: { integrated: number; durationSeconds: number }[],
): number {
  let energyByTime = 0;
  let totalDuration = 0;

  for (const track of tracks) {
    if (!Number.isFinite(track.integrated) || track.durationSeconds <= 0) continue;
    const energy = Math.pow(10, (track.integrated + 0.691) / 10);
    energyByTime += energy * track.durationSeconds;
    totalDuration += track.durationSeconds;
  }

  if (totalDuration === 0) return Number.NEGATIVE_INFINITY;
  return loudnessFromEnergy(energyByTime / totalDuration);
}
