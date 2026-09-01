/**
 * The ZIP writer is validated against external implementations rather than a
 * reader of our own, because a self-consistent bug would pass either way.
 * Run with: npm run test
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZipWriter, type ZipSink } from './streamzip.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}

const dir = mkdtempSync(join(tmpdir(), 'easyaudio-zip-'));
const archivePath = join(dir, 'album.zip');

const chunks: Uint8Array[] = [];
const sink: ZipSink = { write(c) { chunks.push(c.slice()); }, close() {} };
const zip = new ZipWriter(sink);
const enc = new TextEncoder();

const entries: [string, string][] = [
  ['Talk Talk/Spirit of Eden (1988)/1-01 The Rainbow.mp3', 'first track bytes'],
  ['Talk Talk/Spirit of Eden (1988)/folder.jpg', 'cover bytes'],
  // Non-ASCII path exercises the UTF-8 filename flag.
  ['Sigur Ros/Ágætis byrjun (1999)/1-03 Starálfur.mp3', 'third track'],
  ['Talk Talk/Spirit of Eden (1988)/playlist.m3u8', '#EXTM3U\n'],
];
for (const [name, body] of entries) await zip.add(name, enc.encode(body));
await zip.close();

let size = 0;
for (const c of chunks) size += c.length;
const archive = new Uint8Array(size);
let offset = 0;
for (const c of chunks) { archive.set(c, offset); offset += c.length; }
writeFileSync(archivePath, archive);

check('writer byte count matches output', zip.bytesWritten === archive.length);

// External validation: `unzip -t` verifies every CRC.
try {
  const output = execFileSync('unzip', ['-t', archivePath], { encoding: 'utf8' });
  check('unzip reports no errors', output.includes('No errors detected'));
} catch (error) {
  check('unzip reports no errors', false, String(error));
}

// Python's zipfile parses the central directory independently.
try {
  const script = `
import zipfile, json
z = zipfile.ZipFile(${JSON.stringify(archivePath)})
print(json.dumps({
  'bad': z.testzip(),
  'names': z.namelist(),
  'bodies': [z.read(n).decode() for n in z.namelist()],
}))`;
  const output = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  const parsed = JSON.parse(output);
  check('python zipfile finds no corrupt entry', parsed.bad === null);
  check(
    'all names round trip, non-ASCII included',
    JSON.stringify(parsed.names) === JSON.stringify(entries.map((e) => e[0])),
    parsed.names.join(', '),
  );
  check(
    'all payloads round trip',
    JSON.stringify(parsed.bodies) === JSON.stringify(entries.map((e) => e[1])),
  );
} catch (error) {
  check('python zipfile validation', false, String(error));
}

console.log(failures === 0 ? '\nAll ZIP checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
