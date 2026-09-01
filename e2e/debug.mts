import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { writeFixtures } from './fixtures.mts';

const workDir = mkdtempSync(join(tmpdir(), 'ea-dbg-'));
const fixtures = writeFixtures(join(workDir, 'input'));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', String(e)));

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });

const chooserPromise = page.waitForEvent('filechooser');
await page.locator('text=Choose files').first().click();
(await chooserPromise).setFiles(fixtures.map((f) => f.path));

await page.waitForTimeout(8000);

console.log('--- rows:', await page.locator('[role="row"]').count());
console.log('--- store snapshot:');
console.log(await page.evaluate(() => {
  const el = document.body.innerText;
  return el.slice(0, 900);
}));
await page.screenshot({ path: join(workDir, 'debug.png'), fullPage: true });
console.log('screenshot:', join(workDir, 'debug.png'));
await browser.close();
