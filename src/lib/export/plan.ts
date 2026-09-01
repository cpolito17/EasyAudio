/**
 * Normalization planning.
 *
 * The plan is computed once and used by both the UI and the exporter, so the
 * before-and-after figures shown on screen are the same numbers the export will
 * actually produce. Anything else would make the loudness report a guess.
 */

import type { LoudnessReport, NormalizationSettings, Track } from '../../types.ts';
import { albumIntegratedLoudness } from '../audio/loudness.ts';
import { planNormalization } from '../audio/process.ts';
import { GAIN_STEP_DB } from '../mp3/frames.ts';

export interface LoudnessTargetPreset {
  id: NormalizationSettings['targetId'];
  label: string;
  lufs: number;
  ceiling: number;
  description: string;
}

/**
 * Spotify normalises playback to -14 LUFS per ITU-R BS.1770 and recommends
 * keeping true peak below -2 dBTP at that level. The other targets are here
 * because an export may be destined elsewhere.
 */
export const LOUDNESS_TARGETS: LoudnessTargetPreset[] = [
  {
    id: 'spotify',
    label: 'Spotify',
    lufs: -14,
    ceiling: -2,
    description: 'The default playback level, and the streaming standard generally.',
  },
  {
    id: 'spotify-loud',
    label: 'Spotify Loud',
    lufs: -11,
    ceiling: -2,
    description: 'Matches the Loud setting in the Spotify apps.',
  },
  {
    id: 'spotify-quiet',
    label: 'Spotify Quiet',
    lufs: -19,
    ceiling: -1,
    description: 'Matches the Quiet setting. Most headroom, least distortion.',
  },
  {
    id: 'apple',
    label: 'Apple Music',
    lufs: -16,
    ceiling: -1,
    description: 'Sound Check targets a slightly quieter level than Spotify.',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    lufs: -14,
    ceiling: -1,
    description: 'Same loudness as Spotify with a little more peak headroom.',
  },
  {
    id: 'broadcast',
    label: 'Broadcast R128',
    lufs: -23,
    ceiling: -1,
    description: 'EBU R128, the European broadcast standard.',
  },
];

export interface TrackPlan {
  trackId: string;
  /** Gain the export will apply, in dB. */
  gainDb: number;
  /** True when a limiter is needed to hold the peak ceiling. */
  willLimit: boolean;
  /** How far below target the track lands for want of peak headroom, in dB. */
  shortfallDb: number;
  /**
   * Absolute deviation caused by the lossless path moving in 1.5 dB steps.
   * Zero when the track is re-encoded, since that path can apply any gain.
   */
  quantisationDb: number;
  /** Predicted measurements after processing. */
  projected: LoudnessReport;
  /** True when the change can be made without re-encoding. */
  lossless: boolean;
  /** Why a lossless gain change was not possible, when it was not. */
  reencodeReason?: string;
}

export interface NormalizationPlan {
  tracks: Map<string, TrackPlan>;
  /** Measured loudness of the album as a whole, before any change. */
  albumLoudness: number;
  /** The gain album mode asks for, before any quantisation. */
  albumGainDb: number;
  /**
   * The gain that will actually be applied on average, after the lossless path
   * rounds to whole steps. This is what the album really lands at, so it is
   * what the interface must report.
   */
  albumEffectiveGainDb: number;
}

/**
 * Convert a gain to whole global_gain steps.
 *
 * Rounding to the nearest step halves the worst-case error compared with
 * truncating (0.75 dB instead of 1.5 dB). Rounding up can only be unsafe if it
 * pushes the true peak past the ceiling, so that case steps back down.
 */
function quantiseSteps(
  gainDb: number,
  truePeakDb: number,
  ceilingDb: number,
): number {
  let steps = Math.round(gainDb / GAIN_STEP_DB);
  while (steps > 0 && truePeakDb + steps * GAIN_STEP_DB > ceilingDb) steps -= 1;
  return steps;
}

/** Does this track need re-encoding regardless of the gain? */
function forcedReencodeReason(track: Track): string | undefined {
  if (track.audio.format !== 'mp3') {
    return `Source is ${track.audio.format.toUpperCase()}, so it must be converted to MP3.`;
  }
  const { trimStart, trimEnd, fadeIn, fadeOut } = track.edits;
  if (trimStart > 0 || trimEnd > 0) return 'Trimming changes the samples.';
  if (fadeIn > 0 || fadeOut > 0) return 'Fades change the samples.';
  return undefined;
}

/**
 * Project the result of applying a gain.
 *
 * For a pure gain this is exact rather than an estimate: loudness and peak both
 * move by precisely the gain. Once the limiter is involved the loudness figure
 * becomes an upper bound, which the UI flags.
 */
function project(
  loudness: LoudnessReport,
  gainDb: number,
  willLimit: boolean,
  ceilingDb: number,
): LoudnessReport {
  return {
    integrated: Number.isFinite(loudness.integrated)
      ? loudness.integrated + gainDb
      : loudness.integrated,
    range: loudness.range,
    truePeak: willLimit
      ? ceilingDb
      : Number.isFinite(loudness.truePeak)
        ? loudness.truePeak + gainDb
        : loudness.truePeak,
    samplePeak: Number.isFinite(loudness.samplePeak)
      ? Math.min(0, loudness.samplePeak + gainDb)
      : loudness.samplePeak,
    // Applying a gain does not create new clipping in the source material; it
    // is the limiter or the encoder that would, and the ceiling prevents both.
    clippedSamples: loudness.clippedSamples,
    dynamicRange: willLimit
      ? Math.max(0, loudness.dynamicRange - 0.5)
      : loudness.dynamicRange,
  };
}

/** Work out what the export will do to every track. */
export function buildPlan(
  tracks: Track[],
  settings: NormalizationSettings,
): NormalizationPlan {
  const analysed = tracks.filter(
    (track) => track.loudness && Number.isFinite(track.loudness.integrated),
  );

  const albumLoudness = albumIntegratedLoudness(
    analysed.map((track) => ({
      integrated: track.loudness!.integrated,
      durationSeconds: track.audio.durationSeconds,
    })),
  );

  const plans = new Map<string, TrackPlan>();

  if (!settings.enabled) {
    for (const track of tracks) {
      if (!track.loudness) continue;
      const reason = forcedReencodeReason(track);
      plans.set(track.id, {
        trackId: track.id,
        gainDb: 0,
        willLimit: false,
        shortfallDb: 0,
        quantisationDb: 0,
        projected: track.loudness,
        lossless: reason === undefined,
        reencodeReason: reason,
      });
    }
    return {
      tracks: plans,
      albumLoudness,
      albumGainDb: 0,
      albumEffectiveGainDb: 0,
    };
  }

  // Album mode: one gain for the whole release, so the quiet track stays quieter
  // than the loud one exactly as the artist intended. The gain is capped by
  // whichever track would clip first.
  let albumGainDb = 0;
  if (settings.mode === 'album' && Number.isFinite(albumLoudness)) {
    albumGainDb = settings.targetLufs - albumLoudness;

    if (settings.preferGainReduction) {
      let tightestHeadroom = Infinity;
      for (const track of analysed) {
        const headroom = settings.truePeakCeiling - track.loudness!.truePeak;
        if (headroom < tightestHeadroom) tightestHeadroom = headroom;
      }
      if (Number.isFinite(tightestHeadroom)) {
        albumGainDb = Math.min(albumGainDb, tightestHeadroom);
      }
    }
  }

  for (const track of tracks) {
    if (!track.loudness) continue;
    const loudness = track.loudness;

    let gainDb: number;
    let willLimit: boolean;
    let shortfallDb: number;

    if (settings.mode === 'album') {
      gainDb = albumGainDb;
      willLimit = loudness.truePeak + gainDb > settings.truePeakCeiling;
      shortfallDb = 0;
    } else {
      const outcome = planNormalization(
        loudness.integrated,
        loudness.truePeak,
        settings.targetLufs,
        settings.truePeakCeiling,
        settings.preferGainReduction,
      );
      gainDb = outcome.gainDb;
      willLimit = outcome.willLimit;
      shortfallDb = outcome.shortfallDb;
    }

    let reason = forcedReencodeReason(track);

    // A lossless rewrite works in 1.5 dB steps and cannot limit, so anything
    // finer or anything needing a limiter has to be re-encoded.
    if (!reason && willLimit) {
      reason = 'The true-peak limiter has to work on the samples themselves.';
    }
    const lossless = reason === undefined;

    // On the lossless path the gain is quantised to whole steps, so report the
    // value that will really be applied rather than the one asked for. Trading
    // up to 0.75 dB of accuracy for zero generation loss is worth it, but the
    // interface has to be honest that the trade was made.
    const effectiveGain = lossless
      ? quantiseSteps(gainDb, loudness.truePeak, settings.truePeakCeiling) *
        GAIN_STEP_DB
      : gainDb;

    plans.set(track.id, {
      trackId: track.id,
      gainDb: effectiveGain,
      willLimit,
      shortfallDb,
      quantisationDb: Math.abs(gainDb - effectiveGain),
      projected: project(loudness, effectiveGain, willLimit, settings.truePeakCeiling),
      lossless,
      reencodeReason: reason,
    });
  }

  // What the album actually lands at, weighted the same way it was measured.
  let weighted = 0;
  let totalDuration = 0;
  for (const track of analysed) {
    const entry = plans.get(track.id);
    if (!entry) continue;
    weighted += entry.gainDb * track.audio.durationSeconds;
    totalDuration += track.audio.durationSeconds;
  }
  const albumEffectiveGainDb =
    totalDuration > 0 ? weighted / totalDuration : albumGainDb;

  return { tracks: plans, albumLoudness, albumGainDb, albumEffectiveGainDb };
}
