/**
 * Decoding and resampling, using the browser's own codecs.
 *
 * `decodeAudioData` handles MP3, M4A/AAC, FLAC, WAV and Ogg natively, at native
 * speed, with no library to download. That is why the app accepts any input
 * format while shipping only one encoder.
 *
 * AudioContext is not available inside a Web Worker, so decoding happens on the
 * main thread and the resulting sample buffers are transferred to a worker for
 * the CPU-heavy analysis.
 */

import { nearestSupportedRate, isSupportedSampleRate } from '../mp3/encode.ts';

export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
  durationSeconds: number;
}

let sharedContext: AudioContext | null = null;

/**
 * A single suspended AudioContext used only for decoding.
 *
 * Browsers cap the number of contexts a page may create, so opening one per
 * track would fail partway through a hundred-track import.
 */
function decodingContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext();
    // Nothing is played through this context, so leaving it suspended avoids
    // holding an audio device open for the whole session.
    void sharedContext.suspend();
  }
  return sharedContext;
}

function toChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }
  return channels;
}

/**
 * Decode compressed audio to float samples.
 *
 * `decodeAudioData` detaches the ArrayBuffer it is given, so this always hands
 * it a copy: the caller still needs the original bytes to write tags or to run
 * the lossless gain path.
 */
export async function decodeAudio(bytes: Uint8Array): Promise<DecodedAudio> {
  const context = decodingContext();
  const copy = bytes.slice().buffer;

  const buffer = await context.decodeAudioData(copy);

  return {
    channels: toChannels(buffer),
    sampleRate: buffer.sampleRate,
    durationSeconds: buffer.duration,
  };
}

/**
 * Resample to a rate the MP3 encoder accepts.
 *
 * OfflineAudioContext does the conversion with the browser's own high quality
 * resampler, which is better than anything worth hand-writing here.
 */
export async function resample(
  audio: DecodedAudio,
  targetRate: number,
): Promise<DecodedAudio> {
  if (audio.sampleRate === targetRate) return audio;

  const length = Math.max(
    1,
    Math.round((audio.channels[0]?.length ?? 0) * (targetRate / audio.sampleRate)),
  );

  const offline = new OfflineAudioContext(
    audio.channels.length,
    length,
    targetRate,
  );

  const source = offline.createBufferSource();
  const input = offline.createBuffer(
    audio.channels.length,
    audio.channels[0]?.length ?? 1,
    audio.sampleRate,
  );
  for (let i = 0; i < audio.channels.length; i++) {
    // TypeScript models the buffer type of a typed array; the runtime does not.
    input.copyToChannel(audio.channels[i] as Float32Array<ArrayBuffer>, i);
  }

  source.buffer = input;
  source.connect(offline.destination);
  source.start();

  const rendered = await offline.startRendering();

  return {
    channels: toChannels(rendered),
    sampleRate: rendered.sampleRate,
    durationSeconds: rendered.duration,
  };
}

/** Decode and, if needed, resample so the result can always be encoded. */
export async function decodeForExport(bytes: Uint8Array): Promise<DecodedAudio> {
  const decoded = await decodeAudio(bytes);
  if (isSupportedSampleRate(decoded.sampleRate)) return decoded;
  return resample(decoded, nearestSupportedRate(decoded.sampleRate));
}

/** Release the shared decoding context. */
export async function closeDecoder(): Promise<void> {
  if (sharedContext && sharedContext.state !== 'closed') {
    await sharedContext.close();
  }
  sharedContext = null;
}
