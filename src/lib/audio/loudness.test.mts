import {
  analyzeLoudness,
  albumIntegratedLoudness,
  truePeakLinear,
} from './loudness.ts';

function sine(
  freq: number,
  dbfs: number,
  seconds: number,
  sampleRate: number,
  phase = 0,
): Float32Array {
  const amplitude = Math.pow(10, dbfs / 20);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
  }
  return out;
}

let failures = 0;
function check(name: string, actual: number, expected: number, tolerance: number) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual.toFixed(3)}, expected ${expected} +/- ${tolerance}`,
  );
}

// EBU Tech 3341 case 1: stereo 1 kHz sine at -23 dBFS reads -23.0 LUFS.
for (const rate of [44100, 48000]) {
  const ch = sine(1000, -23, 20, rate);
  const r = analyzeLoudness([ch, Float32Array.from(ch)], rate);
  check(`integrated @${rate}Hz, -23 dBFS 1kHz`, r.integrated, -23.0, 0.1);
}

// EBU Tech 3341 case 2: the same tone at -33 dBFS reads -33.0 LUFS.
{
  const ch = sine(1000, -33, 20, 48000);
  const r = analyzeLoudness([ch, Float32Array.from(ch)], 48000);
  check('integrated, -33 dBFS 1kHz', r.integrated, -33.0, 0.1);
}

// Absolute gating: silence must not register as a finite loudness.
{
  const silence = new Float32Array(48000 * 5);
  const r = analyzeLoudness([silence, silence], 48000);
  // -Infinity cannot be compared with a tolerance, so assert the property.
  check('silence is gated out', r.integrated === Number.NEGATIVE_INFINITY ? 1 : 0, 1, 0);
}

// A quiet tone spliced onto a loud one: the -70 LUFS absolute gate must keep
// the near-silent half from dragging the integrated value down.
{
  const loud = sine(1000, -23, 10, 48000);
  const quiet = sine(1000, -90, 10, 48000);
  const joined = new Float32Array(loud.length + quiet.length);
  joined.set(loud, 0);
  joined.set(quiet, loud.length);
  const r = analyzeLoudness([joined, Float32Array.from(joined)], 48000);
  check('gated integrated (loud + near silence)', r.integrated, -23.0, 0.3);
}

// True peak: a 0 dBFS sine placed so its crest falls between two samples must
// read above 0 dBTP. This is exactly the case sample-peak metering misses.
{
  const rate = 48000;
  const worst = sine(rate / 4, 0, 1, rate, Math.PI / 4);
  const tp = 20 * Math.log10(truePeakLinear([worst]));
  const sp = 20 * Math.log10(Math.max(...Array.from(worst, Math.abs)));
  console.log(`      inter-sample check: sample peak ${sp.toFixed(3)} dBFS, true peak ${tp.toFixed(3)} dBTP`);
  check('true peak exceeds sample peak', tp > sp + 1.5 ? 1 : 0, 1, 0);
}

// Unity DC gain: a constant must interpolate to itself. The signal is ramped in
// with a raised cosine so there is no step discontinuity for the reconstruction
// filter to ring on, isolating the branch normalisation from Gibbs overshoot.
{
  const flat = new Float32Array(6000);
  const ramp = 500;
  for (let i = 0; i < flat.length; i++) {
    const gain = i < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp) : 1;
    flat[i] = 0.5 * gain;
  }
  check('polyphase DC gain', truePeakLinear([flat]), 0.5, 0.001);

  // And the edge case above is not a defect: a hard step out of silence really
  // does overshoot, which is the whole reason true-peak metering exists.
  const stepped = new Float32Array(1000).fill(0.5);
  check('hard step rings above the step', truePeakLinear([stepped]) > 0.5 ? 1 : 0, 1, 0);
}

// Loudness range: a constant tone has essentially no range.
{
  const ch = sine(1000, -23, 20, 48000);
  const r = analyzeLoudness([ch, Float32Array.from(ch)], 48000);
  check('LRA of steady tone', r.range, 0, 0.2);
}

// Album loudness weights by duration, not by track count.
{
  const album = albumIntegratedLoudness([
    { integrated: -20, durationSeconds: 30 },
    { integrated: -10, durationSeconds: 570 },
  ]);
  // Dominated by the 9.5 minute track, so it must sit far closer to -10.
  check('album loudness favours the long track', album, -10.2, 0.3);
}

console.log(failures === 0 ? '\nAll loudness checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
