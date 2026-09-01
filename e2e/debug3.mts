import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { writeFixtures } from './fixtures.mts';

const workDir = mkdtempSync(join(tmpdir(), 'ea-dbg3-'));
const fixtures = writeFixtures(join(workDir, 'input'));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));

// Plain JS, no TS syntax, to rule out serialization issues.
await page.addInitScript(`
  window.__zipChunks = [];
  window.__zipDone = false;
  window.showSaveFilePicker = async function () {
    return {
      createWritable: async function () {
        return {
          write: async function (chunk) {
            var view = chunk instanceof ArrayBuffer ? new Uint8Array(chunk)
              : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            window.__zipChunks.push(view.slice());
          },
          close: async function () { window.__zipDone = true; },
        };
      },
    };
  };
`);

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
console.log('stub installed:', await page.evaluate(() => typeof (window as any).showSaveFilePicker));

const cp = page.waitForEvent('filechooser');
await page.locator('text=Choose files').first().click();
(await cp).setFiles(fixtures.map((f) => f.path));
await page.waitForTimeout(9000);

await page.locator('button:has-text("Export")').first().click();
await page.waitForTimeout(400);
await page.locator('button:has-text("Export ZIP")').click();
await page.waitForTimeout(8000);

console.log('zipDone:', await page.evaluate(() => (window as any).__zipDone));
console.log('chunks:', await page.evaluate(() => ((window as any).__zipChunks || []).length));
const panel = await page.locator('aside').last().innerText();
console.log('--- tail of panel ---');
console.log(panel.split('Ready to export')[1]?.slice(0, 400));
await browser.close();
