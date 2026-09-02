/**
 * Inspect the artwork EasyAudio actually embeds.
 *
 * Runs the real pipeline in Chromium (canvas resize, JPEG re-encode, ID3 write,
 * ZIP export), then pulls the APIC frame back out and reports every property a
 * player could plausibly choke on: frame position, MIME string, picture type,
 * description encoding, image dimensions, and crucially whether the JPEG is
 * baseline or progressive.
 */

import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { writeFixtures } from './fixtures.mts';
import { readId3 } from '../src/lib/tags/id3-read.ts';

const BASE_URL = process.env.E2E_URL ?? 'http://localhost:4173';

/** CRC-32, needed for PNG chunks. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  const crcTarget = out.subarray(4, 8 + body.length);
  view.setUint32(8 + body.length, crc32(crcTarget));
  return out;
}

/** Build a real PNG so the test exercises a genuine decode, not a stub. */
function makeCoverPng(size: number): Uint8Array {
  const raw = new Uint8Array(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // Filter: none.
    for (let x = 0; x < size; x++) {
      // A gradient with bands, so JPEG has real content to encode.
      raw[offset++] = Math.floor((x / size) * 255);
      raw[offset++] = Math.floor((y / size) * 255);
      raw[offset++] = (x >> 5) % 2 === (y >> 5) % 2 ? 210 : 40;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // Bit depth.
  ihdr[9] = 2; // Truecolour.

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ];

  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * Report the structure of a JPEG.
 *
 * SOF0 is baseline, SOF2 is progressive. Progressive JPEG is the single most
 * likely encoding difference to render in one player and not another, because
 * some embedded decoders only implement baseline.
 */
function describeJpeg(bytes: Uint8Array) {
  const markers: string[] = [];
  let mode: string | null = null;
  let width = 0;
  let height = 0;
  let offset = 2; // Skip SOI.

  const NAMES: Record<number, string> = {
    0xc0: 'SOF0 (baseline)',
    0xc1: 'SOF1 (extended sequential)',
    0xc2: 'SOF2 (progressive)',
    0xc4: 'DHT',
    0xdb: 'DQT',
    0xdd: 'DRI',
    0xda: 'SOS',
    0xe0: 'APP0 (JFIF)',
    0xe1: 'APP1 (Exif/XMP)',
    0xe2: 'APP2 (ICC profile)',
    0xee: 'APP14 (Adobe)',
    0xfe: 'COM',
  };

  const valid = bytes[0] === 0xff && bytes[1] === 0xd8;

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) break;

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    markers.push(NAMES[marker] ?? `0x${marker.toString(16)}`);

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      mode = NAMES[marker];
      height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      width = (bytes[offset + 7] << 8) | bytes[offset + 8];
    }

    if (marker === 0xda) break; // Entropy-coded data follows.
    offset += 2 + length;
  }

  return { valid, mode, width, height, markers };
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'easyaudio-art-'));
  const fixtures = writeFixtures(join(workDir, 'input'));

  const coverPath = join(workDir, 'cover.png');
  const sourceCover = makeCoverPng(1400);
  writeFileSync(coverPath, sourceCover);
  console.log(`Source cover: 1400x1400 PNG, ${(sourceCover.length / 1024).toFixed(0)} KB\n`);

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (error) => console.log('[pageerror]', String(error)));

  await page.addInitScript(`
    window.__zipChunks = [];
    window.__zipDone = false;
    window.showSaveFilePicker = async function () {
      return {
        createWritable: async function () {
          return {
            write: async function (chunk) {
              var view = chunk instanceof ArrayBuffer
                ? new Uint8Array(chunk)
                : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
              window.__zipChunks.push(view.slice());
            },
            close: async function () { window.__zipDone = true; },
          };
        },
      };
    };
  `);

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('text=Choose files').first().click();
  (await chooserPromise).setFiles(fixtures.slice(0, 3).map((f) => f.path));
  await page.waitForFunction(
    () => document.querySelectorAll('[role="row"]').length >= 3,
    undefined,
    { timeout: 60_000 },
  );

  // Attach the cover through the artwork panel, exactly as a user would.
  await page.locator('button:has-text("Artwork")').first().click();
  await page.waitForTimeout(300);
  const artChooser = page.waitForEvent('filechooser');
  await page.locator('button:has-text("Click to add cover art")').click();
  (await artChooser).setFiles([coverPath]);
  await page.waitForTimeout(2500);

  await page.locator('button:has-text("Export")').first().click();
  await page.waitForTimeout(300);
  await page.locator('button:has-text("Export ZIP")').click();
  await page.waitForFunction(
    () => (window as unknown as { __zipDone: boolean }).__zipDone === true,
    undefined,
    { timeout: 180_000 },
  );

  const base64 = await page.evaluate(() => {
    const chunks = (window as unknown as { __zipChunks: Uint8Array[] }).__zipChunks;
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    let binary = '';
    for (let i = 0; i < all.length; i += 0x8000) {
      binary += String.fromCharCode(...all.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  });
  await browser.close();

  const archivePath = join(workDir, 'album.zip');
  writeFileSync(archivePath, Buffer.from(base64, 'base64'));
  const extractDir = join(workDir, 'extract');
  execFileSync('unzip', ['-q', archivePath, '-d', extractDir]);

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(extractDir);

  const mp3 = files.find((file) => file.endsWith('.mp3'));
  if (!mp3) throw new Error('No MP3 in the archive.');

  const bytes = new Uint8Array(readFileSync(mp3));
  const parsed = readId3(bytes);
  if (!parsed) throw new Error('No ID3 tag found.');

  console.log(`File: ${mp3.slice(extractDir.length + 1)}`);
  console.log(`  total size      ${(bytes.length / 1024).toFixed(0)} KB`);
  console.log(`  ID3 tag length  ${(parsed.tagLength / 1024).toFixed(1)} KB`);

  if (!parsed.picture) {
    console.log('\n  NO ARTWORK EMBEDDED');
    process.exit(1);
  }

  const art = parsed.picture;
  console.log('\nAPIC frame');
  console.log(`  MIME type       "${art.mimeType}"`);
  console.log(`  picture type    ${art.pictureType} ${art.pictureType === 3 ? '(front cover, correct)' : '(NOT front cover)'}`);
  console.log(`  image size      ${(art.bytes.length / 1024).toFixed(0)} KB`);

  // Where does the art sit inside the tag? Some players only scan the start.
  const apicOffset = bytes.findIndex(
    (_, i) =>
      bytes[i] === 0x41 && bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x49 && bytes[i + 3] === 0x43,
  );
  console.log(`  frame offset    ${apicOffset} bytes into the file`);

  const jpeg = describeJpeg(art.bytes);
  console.log('\nEmbedded image');
  console.log(`  valid JPEG      ${jpeg.valid}`);
  console.log(`  encoding        ${jpeg.mode ?? 'unknown'}`);
  console.log(`  dimensions      ${jpeg.width} x ${jpeg.height}`);
  console.log(`  square          ${jpeg.width === jpeg.height}`);
  console.log(`  markers         ${jpeg.markers.join(', ')}`);

  console.log('\nVerdict');
  const problems: string[] = [];
  if (!jpeg.valid) problems.push('the image is not a valid JPEG');
  if (jpeg.mode?.includes('progressive')) {
    problems.push('progressive JPEG, which some decoders reject');
  }
  if (art.mimeType !== 'image/jpeg') problems.push(`unexpected MIME "${art.mimeType}"`);
  if (art.pictureType !== 3) problems.push('picture type is not 3 (front cover)');
  if (jpeg.width !== jpeg.height) problems.push('image is not square');
  if (art.bytes.length > 1_000_000) problems.push('image is over 1 MB');

  if (problems.length === 0) {
    console.log('  The embedded artwork is well formed by every measure checked.');
  } else {
    for (const problem of problems) console.log(`  PROBLEM: ${problem}`);
  }

  console.log(`\nArtifacts in ${workDir}`);
  writeFileSync(join(workDir, 'extracted-cover.jpg'), art.bytes);
  console.log(`Extracted cover written to ${join(workDir, 'extracted-cover.jpg')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
