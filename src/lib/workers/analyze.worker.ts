/**
 * Loudness analysis worker.
 *
 * BS.1770 analysis is genuinely expensive: two biquad passes plus a 4x
 * oversampled peak sweep over every sample. Running it on the main thread would
 * freeze the interface for seconds per track, so the decoded samples are
 * transferred here and the UI stays responsive throughout.
 *
 * Decoding stays on the main thread because AudioContext does not exist in a
 * worker; only the arithmetic moves.
 */

import { analyzeLoudness } from '../audio/loudness.ts';
import type { LoudnessReport } from '../../types.ts';

export interface AnalyzeRequest {
  id: string;
  trackId: string;
  /** Transferred, so the main thread must not touch these afterwards. */
  channels: ArrayBuffer[];
  sampleRate: number;
}

export type AnalyzeResponse =
  | { id: string; trackId: string; ok: true; report: LoudnessReport }
  | { id: string; trackId: string; ok: false; error: string };

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { id, trackId, channels, sampleRate } = event.data;

  try {
    const floats = channels.map((buffer) => new Float32Array(buffer));
    const report = analyzeLoudness(floats, sampleRate);

    const response: AnalyzeResponse = { id, trackId, ok: true, report };
    self.postMessage(response);
  } catch (error) {
    const response: AnalyzeResponse = {
      id,
      trackId,
      ok: false,
      error: error instanceof Error ? error.message : 'Analysis failed.',
    };
    self.postMessage(response);
  }
};
