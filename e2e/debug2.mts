import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { writeFixtures } from './fixtures.mts';

const workDir = mkdtempSync(join(tmpdir(), 'ea-dbg2-'));
const fixtures = writeFixtures(join(workDir, 'input'));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
const cp = page.waitForEvent('filechooser');
await page.locator('text=Choose files').first().click();
(await cp).setFiles(fixtures.map((f) => f.path));
await page.waitForTimeout(9000);

console.log('showSaveFilePicker type:', await page.evaluate(() => typeof (window as any).showSaveFilePicker));

await page.locator('button:has-text("Export")').first().click();
await page.waitForTimeout(400);
await page.locator('button:has-text("Export ZIP")').click();
await page.waitForTimeout(6000);

const panel = await page.locator('aside').last().innerText();
console.log('--- export panel text ---');
console.log(panel.slice(-900));
await page.screenshot({ path: join(workDir, 'export.png'), fullPage: true });
console.log('shot:', join(workDir, 'export.png'));
await browser.close();
