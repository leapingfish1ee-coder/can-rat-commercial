import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

await mkdir('screenshots', { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', message => {
  const text = `[console:${message.type()}] ${message.text()}`;
  console.log(text);
  if (message.type() === 'error') errors.push(text);
});
page.on('pageerror', error => {
  const text = `[pageerror] ${error.stack || error.message}`;
  console.error(text);
  errors.push(text);
});

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForSelector('#loading.hidden', { timeout: 120000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: 'screenshots/yard.png', fullPage: true });

await page.locator('[data-floor="office"]').click();
await page.waitForTimeout(1600);
await page.screenshot({ path: 'screenshots/office.png', fullPage: true });

await page.locator('[data-floor="yard"]').click();
await page.waitForTimeout(900);
const canvas = page.locator('#renderCanvas');
const box = await canvas.boundingBox();
if (box) {
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForTimeout(800);
}
await page.screenshot({ path: 'screenshots/yard-interaction.png', fullPage: true });

if (errors.length > 0) {
  console.error(`Captured ${errors.length} browser errors.`);
  process.exitCode = 2;
}

await browser.close();
