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
  const expectedFallback = text.includes('WebGPU creation/initialization');
  if (message.type() === 'error' && !expectedFallback) errors.push(text);
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

let diagnostics = {};
if (ready) {
  // SwiftShader at 2× DPR can run below 2 FPS. Step the can rigid-body simulation
  // deterministically so rendering throughput cannot invalidate physics checks.
  await page.evaluate(() => {
    const app = globalThis.__CAN_RAT_APP__;
    if (!app) return;
    for (let index = 0; index < 5; index += 1) app.spawnCan(false);
    for (let step = 0; step < 720; step += 1) app.updateCans(1 / 60);
  });

  // Reproduce the original long-session failure directly: dispose many dynamic
  // entities with Babylon's material-disposal flag enabled, then spawn replacements.
  // Shared scene materials must remain alive and retain their original colors.
  const resourceStress = await page.evaluate(() => {
    const app = globalThis.__CAN_RAT_APP__;
    if (!app) return { error: 'missing app' };

    const scene = app.scene;
    const materialEntries = [...app.materials.entries()];
    const colorSnapshot = Object.fromEntries(materialEntries.map(([name, material]) => [
      name,
      material.albedoColor?.toHexString?.() ?? null,
    ]));
    const materialCountBefore = scene.materials.length;

    for (const rat of app.rats) {
      rat.target = undefined;
      rat.state = rat.cargo.length > 0 ? 'returning' : 'seeking';
    }

    while (app.cans.length < 18) app.spawnCan(true);
    const disposableCans = app.cans
      .filter(can => can.state === 'settled' && !can.claimedBy)
      .slice(0, 10);

    for (const can of disposableCans) {
      const index = app.cans.indexOf(can);
      if (index >= 0) app.cans.splice(index, 1);
      const materialChild = can.root.getChildMeshes(false).find(mesh => mesh.material);
      materialChild?.dispose(false, true);
      can.root.dispose(false, true);
    }

    const disposableRat = app.rats.pop();
    if (disposableRat) {
      const materialChild = disposableRat.root.getChildMeshes(false).find(mesh => mesh.material);
      materialChild?.dispose(false, true);
      disposableRat.root.dispose(false, true);
      app.syncRats();
    }

    for (let index = 0; index < 12; index += 1) app.spawnCan(false);
    for (let step = 0; step < 720; step += 1) app.updateCans(1 / 60);

    const materialNamesAfter = new Set(scene.materials.map(material => material.name));
    const missingSharedMaterials = materialEntries
      .filter(([name, material]) => {
        const disposed = typeof material.isDisposed === 'function'
          ? material.isDisposed()
          : Boolean(material._isDisposed);
        return disposed || !materialNamesAfter.has(name);
      })
      .map(([name]) => name);

    const colorDrift = materialEntries
      .filter(([name, material]) => {
        const current = material.albedoColor?.toHexString?.() ?? null;
        return current !== colorSnapshot[name];
      })
      .map(([name]) => name);

    const canMeshesWithoutMaterial = app.cans
      .flatMap(can => can.root.getChildMeshes(false))
      .filter(mesh => !mesh.isDisposed() && !mesh.material)
      .map(mesh => mesh.name);

    return {
      materialCountBefore,
      materialCountAfter: scene.materials.length,
      disposedCanCount: disposableCans.length,
      missingSharedMaterials,
      colorDrift,
      canMeshesWithoutMaterial,
      lifecycle: globalThis.__CAN_RAT_RESOURCE_LIFECYCLE__ ?? null,
      qualityTier: document.querySelector('#quality-tier')?.textContent ?? null,
    };
  });

  await page.waitForTimeout(500);

  diagnostics = await page.evaluate((resourceStress) => {
    const canvas = document.querySelector('#renderCanvas');
    const app = globalThis.__CAN_RAT_APP__;
    const rect = canvas?.getBoundingClientRect();
    const physics = app?.qualityPhysicsDiagnostics ?? {};
    const cans = (app?.cans ?? []).map(can => {
      const q = can.root.rotationQuaternion;
      const axisY = q ? Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)) : 1;
      return {
        state: can.state,
        bounces: can.bounces,
        y: Number(can.root.position.y.toFixed(3)),
        axisY: Number(axisY.toFixed(4)),
      };
    });
    return {
      pixelRatioX: canvas && rect ? canvas.width / rect.width : 0,
      pixelRatioY: canvas && rect ? canvas.height / rect.height : 0,
      physics,
      resourceStress,
      canStates: cans.reduce((acc, can) => {
        acc[can.state] = (acc[can.state] ?? 0) + 1;
        return acc;
      }, {}),
      nonUprightSettledLive: cans.filter(can => can.state === 'settled' && can.bounces > 0 && can.axisY < 0.9).length,
      cans,
    };
  }, resourceStress);

  await writeFile('screenshots/render-diagnostics.json', JSON.stringify(diagnostics, null, 2));
  console.log('[diagnostics]', JSON.stringify(diagnostics));

  if (diagnostics.pixelRatioX < 1.8 || diagnostics.pixelRatioY < 1.8) {
    errors.push(`[quality] expected Retina-scale canvas, got ${diagnostics.pixelRatioX.toFixed(2)} × ${diagnostics.pixelRatioY.toFixed(2)}`);
  }
  if ((diagnostics.physics?.settled ?? 0) < 1) {
    errors.push('[physics] deterministic stepping produced no settled cans');
  }
  if ((diagnostics.physics?.nonUpright ?? 0) < 1 || diagnostics.nonUprightSettledLive < 1) {
    errors.push('[physics] settled cans did not preserve non-upright resting poses');
  }
  if ((resourceStress.lifecycle?.preventedMaterialDisposals ?? 0) < 3) {
    errors.push('[resources] lifecycle guard did not intercept expected dynamic disposals');
  }
  if ((resourceStress.missingSharedMaterials ?? []).length > 0) {
    errors.push(`[resources] shared materials disappeared: ${resourceStress.missingSharedMaterials.join(', ')}`);
  }
  if ((resourceStress.colorDrift ?? []).length > 0) {
    errors.push(`[resources] shared material colors changed: ${resourceStress.colorDrift.join(', ')}`);
  }
  if ((resourceStress.canMeshesWithoutMaterial ?? []).length > 0) {
    errors.push(`[resources] live can meshes lost materials: ${resourceStress.canMeshesWithoutMaterial.join(', ')}`);
  }
  if (resourceStress.qualityTier !== 'HIGH') {
    errors.push(`[quality] desktop effective tier should report HIGH, got ${resourceStress.qualityTier}`);
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
