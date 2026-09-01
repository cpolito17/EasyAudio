/**
 * End-to-end verification against the real built app in a real browser.
 *
 * This exercises the parts that unit tests cannot reach: decoding through the
 * Web Audio API, the analysis worker, OPFS persistence, and the export writing
 * an archive. It then unpacks that archive and checks the tags and the loudness
 * of what actually came out.
 *
 * Run with: npm run e2e
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';
import { MPEGDecoder } from 'mpg123-decoder';

import { writeFixtures } from './fixtures.mts';
import { readId3 } from '../src/lib/tags/id3-read.ts';
import { analyzeLoudness } from '../src/lib/audio/loudness.ts';

const BASE_URL = process.env.E2E_URL ?? 'http://localhost:4173';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'easyaudio-e2e-'));
  const fixtures = writeFixtures(join(workDir, 'input'));
  console.log(`Fixtures in ${workDir}/input\n`);

  const browser: Browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  const page: Page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // Headless Chromium cannot show a save dialog, so showSaveFilePicker rejects
  // with AbortError, which the app correctly treats as "the user cancelled".
  // Stubbing it with a real sink lets the streaming export path be tested, and
  // is exactly the shape the File System Access API provides.
  // Playwright serialises init scripts into the page, so this is written as a
  // plain string rather than a typed function.
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

  // ---- The app loads -------------------------------------------------------
  check('app renders', await page.locator('text=EasyAudio').first().isVisible());
  check(
    'empty state is shown',
    await page.locator('text=Choose files').first().isVisible(),
  );

  await page.screenshot({ path: join(workDir, '1-empty.png'), fullPage: false });

  // ---- Import --------------------------------------------------------------
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('text=Choose files').first().click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixtures.map((fixture) => fixture.path));

  // Wait for every track to finish analysis, which is the slow part.
  await page.waitForFunction(
    () => document.querySelectorAll('[role="row"]').length >= 3,
    undefined,
    { timeout: 60_000 },
  );

  // Three tagged tracks group into one album; the untagged one lands in its own
  // "Unknown Album" because it carries no album tag. That is correct, and the
  // next step exercises moving it into place.
  const albumButtons = await page.locator('nav[aria-label="Albums"] li').count();
  check('two albums created from the tags', albumButtons === 2, `${albumButtons} albums`);

  const rowCount = await page.locator('[role="row"]').count();
  check('tagged album holds three tracks', rowCount === 3, `${rowCount} rows`);

  const bodyText = await page.locator('body').innerText();
  check('album grouped from tags', bodyText.includes('Harbour Lights'));
  for (const fixture of fixtures.slice(0, 3)) {
    check(`ID3 title read: ${fixture.expectedTitle}`, bodyText.includes(fixture.expectedTitle));
  }

  // ---- Regroup the untagged track through the UI ----------------------------
  // Selecting the second album, then moving its track into the first, exercises
  // both filename inference and the grouping control.
  await page.locator('nav[aria-label="Albums"] li button').nth(1).click();
  await page.waitForTimeout(300);
  const strayText = await page.locator('body').innerText();
  check(
    'title inferred from filename',
    strayText.includes('Night Ferry'),
    'expected Night Ferry from "04 - Marisa Okonkwo - Night Ferry.mp3"',
  );

  await page.locator('button:has-text("Tags")').first().click();
  await page.waitForTimeout(200);
  const moveSelect = page.locator('select').filter({ hasText: 'Harbour Lights' }).first();
  await moveSelect.selectOption({ index: 0 });
  await page.waitForTimeout(500);

  const regrouped = await page.locator('[role="row"]').count();
  check('track moved into the album', regrouped === 4, `${regrouped} rows`);

  // Wait until the LUFS column has real numbers rather than placeholders.
  await page.waitForFunction(
    () => {
      const rows = Array.from(document.querySelectorAll('[role="row"]'));
      if (rows.length < 3) return false;
      return rows.every((row) => /-\d+\.\d/.test(row.textContent ?? ''));
    },
    undefined,
    { timeout: 120_000 },
  );
  check('loudness measured for every track', true);

  await page.screenshot({ path: join(workDir, '2-tracks.png') });

  // ---- Loudness panel ------------------------------------------------------
  await page.locator('button:has-text("Loudness")').first().click();
  await page.waitForTimeout(400);
  const loudnessText = await page.locator('aside').last().innerText();
  check(
    'album measurement is shown',
    /-\d+\.\d/.test(loudnessText) && loudnessText.includes('LUFS'),
  );
  check(
    'lossless path is reported',
    loudnessText.toLowerCase().includes('without re-encoding'),
  );
  await page.screenshot({ path: join(workDir, '3-loudness.png') });

  // ---- Export --------------------------------------------------------------
  await page.locator('button:has-text("Export")').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(workDir, '4-export.png') });

  await page.locator('button:has-text("Export ZIP")').click();

  await page.waitForFunction(
    () => (window as unknown as { __zipDone: boolean }).__zipDone === true,
    undefined,
    { timeout: 180_000 },
  );
  check('export streamed to a file sink', true);

  const archiveBase64 = await page.evaluate(() => {
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
    const step = 0x8000;
    for (let i = 0; i < all.length; i += step) {
      binary += String.fromCharCode(...all.subarray(i, i + step));
    }
    return btoa(binary);
  });

  const archivePath = join(workDir, 'album.zip');
  writeFileSync(archivePath, Buffer.from(archiveBase64, 'base64'));
  check('archive written', existsSync(archivePath));

  // ---- Verify the archive --------------------------------------------------
  const extractDir = join(workDir, 'extract');
  execFileSync('unzip', ['-q', archivePath, '-d', extractDir]);
  const listing = execFileSync('unzip', ['-t', archivePath], { encoding: 'utf8' });
  check('archive passes integrity check', listing.includes('No errors detected'));

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(extractDir);

  const mp3Files = files.filter((file) => file.endsWith('.mp3')).sort();
  check(
    'loudness report included',
    files.some((file) => file.endsWith('loudness-report.txt')),
  );
  check(
    'playlist included',
    files.some((file) => file.endsWith('.m3u8')),
  );

  const relative = mp3Files.map((file) => file.slice(extractDir.length + 1));
  console.log('\n  Archive contents:');
  for (const file of files) console.log(`    ${file.slice(extractDir.length + 1)}`);

  check(
    'path template applied',
    relative.every((path) => path.startsWith('Marisa Okonkwo/Harbour Lights (2024)/')),
    relative[0],
  );

  // ---- Verify tags survived the round trip ---------------------------------
  check('four MP3s after regrouping', mp3Files.length === 4, `${mp3Files.length}`);
  const firstTrack = mp3Files.find((file) => file.includes('1-01'));
  check('track 1 named by template', Boolean(firstTrack), relative.join(', '));

  if (firstTrack) {
    const bytes = new Uint8Array(readFileSync(firstTrack));
    const parsed = readId3(bytes);
    check('exported file has an ID3 tag', parsed !== null);
    if (parsed) {
      check('title round trips', parsed.title === 'Low Tide', parsed.title);
      check('album artist round trips', parsed.albumArtist === 'Marisa Okonkwo', parsed.albumArtist);
      check('album round trips', parsed.album === 'Harbour Lights', parsed.album);
      check('track number round trips', parsed.track === 1, String(parsed.track));
      check('track total round trips', parsed.trackTotal > 0, String(parsed.trackTotal));
      check('year round trips', parsed.year === '2024', parsed.year);
      check('genre round trips', parsed.genre === 'Ambient', parsed.genre);
      check(
        'ReplayGain tag written',
        parsed.replayGainTrack.length > 0,
        parsed.replayGainTrack,
      );
    }
  }

  // ---- Verify the audio was actually normalized ----------------------------
  const report = files.find((file) => file.endsWith('loudness-report.txt'));
  if (report) {
    const text = readFileSync(report, 'utf8');
    console.log('\n  Loudness report:\n');
    console.log(text.split('\n').map((line) => `    ${line}`).join('\n'));
    check('report names the target', text.includes('-14'));
    const dataLines = text
      .split('\n')
      .filter((line) => /^\d+\. /.test(line.trim()));
    check('report has a row per track', dataLines.length === 4, `${dataLines.length}`);
    check(
      'report gain column is populated',
      dataLines.every((line) => /[+-]\d+\.\d/.test(line)),
    );
    check(
      'report records the lossless method',
      dataLines.every((line) => line.includes('lossless')),
    );
  }

  // Decode two exported tracks and confirm the album relationship survived.
  const measure = async (file: string) => {
    const decoder = new MPEGDecoder();
    await decoder.ready;
    const decoded = decoder.decode(new Uint8Array(readFileSync(file)));
    decoder.free();
    return analyzeLoudness(decoded.channelData as Float32Array[], decoded.sampleRate);
  };

  const quiet = mp3Files.find((file) => file.includes('Low Tide'));
  const loud = mp3Files.find((file) => file.includes('Breakwater'));

  if (quiet && loud) {
    const quietReport = await measure(quiet);
    const loudReport = await measure(loud);
    console.log(
      `\n  Measured output: Low Tide ${quietReport.integrated.toFixed(2)} LUFS, ` +
        `Breakwater ${loudReport.integrated.toFixed(2)} LUFS`,
    );

    // Album mode applies one gain, so the 19 dB gap between the quietest and
    // loudest source must survive essentially intact. That is the whole point
    // of album mode, and per-track mode would have flattened it.
    const gap = loudReport.integrated - quietReport.integrated;
    check(
      'album mode preserved the relative levels',
      Math.abs(gap - 19) < 1.5,
      `${gap.toFixed(2)} dB between quietest and loudest`,
    );

    // The loud track anchors the album, so it should sit near the ceiling and
    // the whole album should have moved upward from where it started.
    check(
      'exported audio is louder than the source',
      loudReport.integrated > -14,
      `${loudReport.integrated.toFixed(2)} LUFS`,
    );
    check(
      'no clipping introduced',
      loudReport.truePeak <= 0.2,
      `${loudReport.truePeak.toFixed(2)} dBTP`,
    );
  }

  // ---- The fallback path browsers without the picker take -------------------
  // Firefox and Safari have no File System Access API, so the archive is built
  // in memory and handed over as a download. That path needs testing too.
  const fallbackPage = await context.newPage();
  await fallbackPage.addInitScript('delete window.showSaveFilePicker;');
  await fallbackPage.goto(BASE_URL, { waitUntil: 'networkidle' });
  await fallbackPage.waitForFunction(
    () => document.querySelectorAll('[role="row"]').length >= 3,
    undefined,
    { timeout: 60_000 },
  );
  check('project restored from browser storage in a new tab', true);

  await fallbackPage.locator('button:has-text("Export")').first().click();
  await fallbackPage.waitForTimeout(300);
  const fallbackDownload = fallbackPage.waitForEvent('download', { timeout: 180_000 });
  await fallbackPage.locator('button:has-text("Export ZIP")').click();
  const download = await fallbackDownload;
  const fallbackPath = join(workDir, 'fallback.zip');
  await download.saveAs(fallbackPath);
  check('blob fallback produced a download', existsSync(fallbackPath));
  const fallbackListing = execFileSync('unzip', ['-t', fallbackPath], { encoding: 'utf8' });
  check(
    'fallback archive is valid',
    fallbackListing.includes('No errors detected'),
  );

  // ---- No console errors ---------------------------------------------------
  const realErrors = consoleErrors.filter(
    (message) =>
      // A failed favicon or an aborted fetch is noise, not a defect.
      !message.includes('favicon') && !message.includes('ERR_ABORTED'),
  );
  check(
    'no console errors',
    realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '),
  );

  console.log(`\n  Screenshots and artifacts in ${workDir}`);

  await browser.close();

  console.log(
    failures === 0
      ? '\nAll end-to-end checks passed.'
      : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
