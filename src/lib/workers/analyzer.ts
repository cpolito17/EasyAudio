/**
 * Main-thread side of the analysis worker.
 *
 * Decoding happens here (AudioContext is unavailable in workers), the samples
 * are transferred out for measurement, and nothing is retained afterwards. That
 * last part matters: a four minute stereo track is about 84 MB of float samples,
 * so a hundred of them held at once would exhaust the tab many times over. Only
 * the small report survives.
 */

import type { LoudnessReport } from '../../types.ts';
import { decodeAudio } from '../audio/decode.ts';
import type { AnalyzeRequest, AnalyzeResponse } from './analyze.worker.ts';

interface Pending {
  resolve: (report: LoudnessReport) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
const pending = new Map<string, Pending>();
let nextId = 0;

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), {
    type: 'module',
  });

  worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);

    if (event.data.ok) entry.resolve(event.data.report);
    else entry.reject(new Error(event.data.error));
  };

  worker.onerror = (event) => {
    // A worker-level failure invalidates everything in flight.
    const error = new Error(event.message || 'The analysis worker failed.');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

export interface AnalysisResult {
  report: LoudnessReport;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

/**
 * Decode a file and measure it.
 *
 * The decoded samples are copied before transfer because `decodeAudioData`
 * returns buffers owned by the AudioBuffer, and detaching those would leave the
 * browser's own object in an invalid state.
 */
export async function analyzeFile(
  trackId: string,
  bytes: Uint8Array,
): Promise<AnalysisResult> {
  const decoded = await decodeAudio(bytes);

  const transferable: ArrayBuffer[] = decoded.channels.map(
    (channel) => new Float32Array(channel).buffer,
  );

  const id = `analysis-${nextId++}`;
  const request: AnalyzeRequest = {
    id,
    trackId,
    channels: transferable,
    sampleRate: decoded.sampleRate,
  };

  const report = await new Promise<LoudnessReport>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage(request, transferable);
  });

  return {
    report,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels.length,
    durationSeconds: decoded.durationSeconds,
  };
}

/** Shut the worker down, for example when the project is cleared. */
export function terminateAnalyzer(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
