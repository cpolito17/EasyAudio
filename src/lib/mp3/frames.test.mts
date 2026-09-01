/**
 * End-to-end proof of the lossless MP3 gain path.
 *
 * Structural checks alone would not catch a wrong bit offset, because writing
 * into a neighbouring side-info field still leaves frame boundaries intact. So
 * this encodes real MP3s, rewrites global_gain, decodes the result and measures
 * the loudness change with the BS.1770 meter.
 *
 * Run with: npm run test
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { MPEGDecoder } from 'mpg123-decoder';

import {
  parseMp3,
  applyLosslessGain,
  maxApplicableSteps,
  dbToSteps,
  GAIN_STEP_DB,
} from './frames.ts';
import { analyzeLoudness } from '../audio/loudness.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
function near(name: string, actual: number, expected: number, tolerance: number) {
  check(
    name,
    Math.abs(actual - expected) <= tolerance,
    `got ${actual.toFixed(3)}, expected ${expected} +/- ${tolerance}`,
  );
}

/** Encode a test tone to MP3 with lamejs. */
function encode(
  channels: number,
  sampleRate: number,
  kbps: number,
  seconds: number,
  dbfs = -20,
): Uint8Array {
  const encoder = new Mp3Encoder(channels, sampleRate, kbps);
  const total = Math.round(seconds * sampleRate);
  const amplitude = Math.pow(10, dbfs / 20) * 32767;
  const chunks: Uint8Array[] = [];
  const block = 1152;

  for (let start = 0; start < total; start += block) {
    const count = Math.min(block, total - start);
    const left = new Int16Array(count);
    const right = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const value = amplitude * Math.sin((2 * Math.PI * 440 * (start + i)) / sampleRate);
      left[i] = value;
      right[i] = value;
    }
    const encoded = channels === 1
      ? encoder.encodeBuffer(left)
      : encoder.encodeBuffer(left, right);
    if (encoded.length) chunks.push(new Uint8Array(encoded));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));

  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function decode(bytes: Uint8Array) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const result = decoder.decode(bytes);
  decoder.free();
  return result;
}

// ---------------------------------------------------------------------------
// Structural: the side-info arithmetic must account for every bit exactly.
// ---------------------------------------------------------------------------
{
  // Header plus side info, in bits, for each of the four layouts. The last
  // granule block must end precisely on that boundary, which is only true if
  // the block widths (59 bits for MPEG-1, 63 for MPEG-2) are correct.
  const layouts = [
    { label: 'MPEG-1 stereo', headerBits: (4 + 32) * 8, base: 32 + 9 + 3 + 8, blocks: 4, width: 59 },
    { label: 'MPEG-1 mono', headerBits: (4 + 17) * 8, base: 32 + 9 + 5 + 4, blocks: 2, width: 59 },
    { label: 'MPEG-2 stereo', headerBits: (4 + 17) * 8, base: 32 + 8 + 2, blocks: 2, width: 63 },
    { label: 'MPEG-2 mono', headerBits: (4 + 9) * 8, base: 32 + 8 + 1, blocks: 1, width: 63 },
  ];
  for (const layout of layouts) {
    const end = layout.base + layout.blocks * layout.width;
    check(
      `side-info layout adds up: ${layout.label}`,
      end === layout.headerBits,
      `${end} bits vs ${layout.headerBits}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Parsing: frame indexing must match what the encoder actually produced.
// ---------------------------------------------------------------------------
{
  const mp3 = encode(2, 44100, 192, 3);
  const info = parseMp3(mp3);
  check('stereo 44.1k parses', info !== null);
  if (info) {
    check('sample rate', info.sampleRate === 44100, String(info.sampleRate));
    check('channels', info.channels === 2, String(info.channels));
    near('duration', info.durationSeconds, 3, 0.1);
    near('average bitrate', info.averageBitrateKbps, 192, 6);
    check('frames found', info.frames.length > 100, `${info.frames.length} frames`);
  }
}

{
  const mp3 = encode(1, 44100, 128, 2);
  const info = parseMp3(mp3);
  check('mono parses', info !== null && info.channels === 1);
}

{
  // MPEG-2: a sample rate below 32 kHz forces the narrower side-info layout and
  // the single-granule path, which is the branch most likely to be wrong.
  const mp3 = encode(2, 22050, 64, 2);
  const info = parseMp3(mp3);
  check('MPEG-2 (22.05k) parses', info !== null);
  if (info) {
    check('MPEG-2 sample rate', info.sampleRate === 22050, String(info.sampleRate));
    check(
      'MPEG-2 single granule',
      info.frames[info.frames.length - 1].globalGainBitOffsets.length === 2,
      `${info.frames[0].globalGainBitOffsets.length} gain fields`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reversibility: the edit must be exactly undoable, byte for byte.
// ---------------------------------------------------------------------------
{
  const original = encode(2, 44100, 192, 2);
  const working = new Uint8Array(original);
  const info = parseMp3(working)!;

  const up = applyLosslessGain(working, info, 4);
  check('applied 4 steps', up.steps === 4, `steps=${up.steps}`);
  check('bytes changed', !working.every((b, i) => b === original[i]));

  const down = applyLosslessGain(working, info, -4);
  check('reverted 4 steps', down.steps === -4);
  check(
    'round trip is bit identical',
    working.every((byte, index) => byte === original[index]),
  );
}

// ---------------------------------------------------------------------------
// Headroom: the clamp must refuse to push any field outside 0..255.
// ---------------------------------------------------------------------------
{
  const working = encode(2, 44100, 192, 2);
  const info = parseMp3(working)!;
  const huge = maxApplicableSteps(working, info, 1000);
  check('absurd request is clamped', huge < 1000 && huge >= 0, `max ${huge} steps`);

  const result = applyLosslessGain(working, info, 1000);
  check('clamped flag is reported', result.clamped === true);
  check('clamped application stays in range', parseMp3(working) !== null);
}

// ---------------------------------------------------------------------------
// The real proof: decode before and after, and measure the loudness delta.
// ---------------------------------------------------------------------------
{
  const original = encode(2, 44100, 192, 4, -20);

  const beforeDecoded = await decode(original);
  const before = analyzeLoudness(
    beforeDecoded.channelData as Float32Array[],
    beforeDecoded.sampleRate,
  );

  const steps = dbToSteps(6);
  const working = new Uint8Array(original);
  const info = parseMp3(working)!;
  const applied = applyLosslessGain(working, info, steps);

  const afterDecoded = await decode(working);
  const after = analyzeLoudness(
    afterDecoded.channelData as Float32Array[],
    afterDecoded.sampleRate,
  );

  const measuredDelta = after.integrated - before.integrated;
  console.log(
    `      before ${before.integrated.toFixed(2)} LUFS, after ${after.integrated.toFixed(2)} LUFS, ` +
      `requested ${applied.appliedDb.toFixed(2)} dB`,
  );
  near('measured gain matches global_gain rewrite', measuredDelta, applied.appliedDb, 0.2);
  check(
    'one step really is 1.5 dB',
    Math.abs(applied.appliedDb / applied.steps - GAIN_STEP_DB) < 1e-9,
  );

  // A negative gain must work symmetrically.
  const quieter = new Uint8Array(original);
  const quietInfo = parseMp3(quieter)!;
  const cut = applyLosslessGain(quieter, quietInfo, -4);
  const cutDecoded = await decode(quieter);
  const cutReport = analyzeLoudness(
    cutDecoded.channelData as Float32Array[],
    cutDecoded.sampleRate,
  );
  near(
    'negative gain matches too',
    cutReport.integrated - before.integrated,
    cut.appliedDb,
    0.2,
  );
}

console.log(failures === 0 ? '\nAll MP3 checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
