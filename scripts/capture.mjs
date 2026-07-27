import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('screenshots', { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-features=Vulkan,WebGPU'
  ]
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

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

await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded', timeout: 120000 });

let ready = false;
try {
  await page.waitForSelector('#loading.hidden', { timeout: 25000 });
  ready = true;
} catch {
  errors.push('[capture] #loading.hidden was not reached within 25 seconds');
}

await page.waitForTimeout(7000);

if (ready) {
  const diagnostics = await page.evaluate(() => {
    const canvas = document.querySelector('#renderCanvas');
    const app = globalThis.__CAN_RAT_APP__;
    const rect = canvas?.getBoundingClientRect();
    const settledDynamic = (app?.cans ?? []).filter(can => can.state === 'settled' && can.bounces > 0);
    const poses = settledDynamic.map(can => {
      const q = can.root.rotationQuaternion;
      if (!q) return { axisY: 1, bounces: can.bounces };
      const axisY = Math.abs(1 - 2 * (q.x * q.x + q.z * q.z));
      return { axisY, bounces: can.bounces };
    });
    return {
      pixelRatioX: canvas && rect ? canvas.width / rect.width : 0,
      pixelRatioY: canvas && rect ? canvas.height / rect.height : 0,
      settledDynamicCount: settledDynamic.length,
      nonUprightCount: poses.filter(pose => pose.axisY < 0.9).length,
      poses,
    };
  });

  await writeFile('screenshots/render-diagnostics.json', JSON.stringify(diagnostics, null, 2));
  console.log('[diagnostics]', JSON.stringify(diagnostics));

  if (diagnostics.pixelRatioX < 1.8 || diagnostics.pixelRatioY < 1.8) {
    errors.push(`[quality] expected Retina-scale canvas, got ${diagnostics.pixelRatioX.toFixed(2)} × ${diagnostics.pixelRatioY.toFixed(2)}`);
  }
  if (diagnostics.settledDynamicCount < 1) {
    errors.push('[physics] no dynamically fallen can reached the settled state');
  }
  if (diagnostics.nonUprightCount < 1) {
    errors.push('[physics] all dynamically fallen cans were upright; natural settling regression suspected');
  }
}

await page.screenshot({ path: 'screenshots/yard.png', fullPage: true });

if (ready) {
  await page.locator('[data-floor="office"]').click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'screenshots/office.png', fullPage: true });

  await page.locator('[data-floor="yard"]').click();
  await page.waitForTimeout(900);
  const canvas = page.locator('#renderCanvas');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: 'screenshots/yard-interaction.png', fullPage: true });
}

await writeFile('screenshots/browser-errors.txt', errors.length ? errors.join('\n') : 'No browser errors captured.\n');
console.log(`Capture completed. ready=${ready}; browserErrors=${errors.length}`);
await browser.close();
if (errors.length) process.exitCode = 2;
