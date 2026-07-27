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
  await page.waitForSelector('#loading.hidden', { timeout: 30000 });
  ready = true;
} catch {
  errors.push('[capture] #loading.hidden was not reached within 30 seconds');
}

let diagnostics = {};
if (ready) {
  const assetResponse = await page.request.get('http://127.0.0.1:5173/assets/rat.dae');
  const textureResponse = await page.request.get('http://127.0.0.1:5173/assets/rat.png');
  const assetText = assetResponse.ok() ? await assetResponse.text() : '';
  const textureBytes = textureResponse.ok() ? (await textureResponse.body()).length : 0;

  // SwiftShader can render at less than two frames per second at Retina density.
  // Advance gameplay deterministically while also aging transient impact rings.
  await page.evaluate(() => {
    const app = globalThis.__CAN_RAT_APP__;
    if (!app) return;
    for (let index = 0; index < 8; index += 1) app.spawnCan(false);
    for (let step = 0; step < 900; step += 1) {
      app.updateCans(1 / 60);
      app.updateImpacts(1 / 60);
    }
    const candidate = app.cans.find(can => can.state === 'settled' && !can.claimedBy);
    if (candidate) {
      candidate.root.position.x = 0;
      candidate.root.position.z = 0;
      candidate.velocity.setAll(0);
      candidate.spin.setAll(0);
      app.stomp(candidate, 0.96);
    }
  });

  // Capture the contact/overshoot phase separately; this verifies that the visual
  // feedback comes from can deformation rather than a boot or camera shake.
  await page.waitForTimeout(330);
  await page.screenshot({ path: 'screenshots/squash.png', fullPage: true });
  await page.waitForTimeout(1050);

  // Allow the asynchronously loaded Collada asset to replace the procedural rat.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await page.evaluate(() => globalThis.__CAN_RAT_APP__?.ratAssetDiagnostics ?? null);
    if (state?.loaded || state?.failed) break;
    await page.waitForTimeout(250);
  }

  await page.evaluate(() => {
    const app = globalThis.__CAN_RAT_APP__;
    if (!app) return;
    for (let step = 0; step < 480; step += 1) {
      app.updateCans(1 / 60);
      app.updateImpacts(1 / 60);
    }
    // Clear only transient test effects; gameplay entities and physics states remain.
    for (const impact of [...app.impacts]) impact.mesh.dispose();
    app.impacts.splice(0);
  });
  await page.waitForTimeout(500);

  diagnostics = await page.evaluate(({ assetStatus, assetLength, textureStatus, textureLength }) => {
    const canvas = document.querySelector('#renderCanvas');
    const app = globalThis.__CAN_RAT_APP__;
    const rect = canvas?.getBoundingClientRect();
    const cans = (app?.cans ?? []).map(can => {
      const q = can.root.rotationQuaternion;
      const axisY = q ? Math.abs(1 - 2 * (q.x * q.x + q.z * q.z)) : 1;
      return {
        state: can.state,
        bounces: can.bounces,
        stompMultiplier: can.stompMultiplier,
        scale: {
          x: Number(can.root.scaling.x.toFixed(3)),
          y: Number(can.root.scaling.y.toFixed(3)),
          z: Number(can.root.scaling.z.toFixed(3)),
        },
        axisY: Number(axisY.toFixed(4)),
        speed: Number(Math.hypot(can.velocity.x, can.velocity.y, can.velocity.z).toFixed(4)),
        spin: Number(can.spin.length().toFixed(4)),
      };
    });

    const materialEntries = [...(app?.materials?.entries?.() ?? [])];
    const missingSharedMaterials = materialEntries
      .filter(([name, material]) => {
        const disposed = typeof material.isDisposed === 'function'
          ? material.isDisposed()
          : Boolean(material._isDisposed);
        return disposed || !app.scene.materials.some(candidate => candidate.name === name);
      })
      .map(([name]) => name);

    return {
      assetStatus,
      assetLength,
      textureStatus,
      textureLength,
      pixelRatioX: canvas && rect ? canvas.width / rect.width : 0,
      pixelRatioY: canvas && rect ? canvas.height / rect.height : 0,
      continuous: app?.continuousPhysicsDiagnostics ?? null,
      ratAsset: app?.ratAssetDiagnostics ?? null,
      qualityTier: document.querySelector('#quality-tier')?.textContent ?? null,
      footMeshCount: app?.scene?.meshes?.filter(mesh => mesh.name.startsWith('foot-')).length ?? -1,
      publicRatMeshCount: app?.scene?.meshes?.filter(mesh => mesh.name.includes('-cc0-part-')).length ?? 0,
      missingSharedMaterials,
      crushedCans: cans.filter(can => can.stompMultiplier !== 1),
      movingCollectableCans: cans.filter(can => can.state === 'settled' && (can.speed > 0.03 || can.spin > 0.06)).length,
      canStates: cans.reduce((acc, can) => {
        acc[can.state] = (acc[can.state] ?? 0) + 1;
        return acc;
      }, {}),
      cans,
    };
  }, {
    assetStatus: assetResponse.status(),
    assetLength: assetText.length,
    textureStatus: textureResponse.status(),
    textureLength: textureBytes,
  });

  await writeFile('screenshots/render-diagnostics.json', JSON.stringify(diagnostics, null, 2));
  console.log('[diagnostics]', JSON.stringify(diagnostics));

  if (diagnostics.pixelRatioX < 1.8 || diagnostics.pixelRatioY < 1.8) {
    errors.push(`[quality] expected Retina canvas, got ${diagnostics.pixelRatioX.toFixed(2)} × ${diagnostics.pixelRatioY.toFixed(2)}`);
  }
  if (diagnostics.assetStatus !== 200 || diagnostics.assetLength < 100000) {
    errors.push(`[asset] CC0 rat endpoint invalid: HTTP ${diagnostics.assetStatus}, ${diagnostics.assetLength} bytes`);
  }
  if (diagnostics.textureStatus !== 200 || diagnostics.textureLength < 100000) {
    errors.push(`[asset] CC0 rat texture invalid: HTTP ${diagnostics.textureStatus}, ${diagnostics.textureLength} bytes`);
  }
  if (!diagnostics.ratAsset?.loaded || diagnostics.ratAsset.attached < 1 || diagnostics.publicRatMeshCount < 1) {
    errors.push(`[asset] public rat model was not attached: ${JSON.stringify(diagnostics.ratAsset)}`);
  }
  if ((diagnostics.continuous?.frames ?? 0) < 1000 || (diagnostics.continuous?.floorContacts ?? 0) < 1) {
    errors.push(`[physics] continuous simulation did not advance correctly: ${JSON.stringify(diagnostics.continuous)}`);
  }
  if ((diagnostics.continuous?.movingCollectable ?? 0) < 1) {
    errors.push('[physics] no collectable can remained active in the physics simulation');
  }
  if ((diagnostics.continuous?.squashAnimations ?? 0) < 1 || diagnostics.crushedCans.length < 1) {
    errors.push('[animation] squash-and-stretch stomp was not executed');
  }
  if (diagnostics.footMeshCount !== 0) {
    errors.push(`[animation] boot meshes remain in the scene: ${diagnostics.footMeshCount}`);
  }
  if (!diagnostics.crushedCans.some(can => can.scale.y < 0.45 && can.scale.x > 1.25 && can.axisY < 0.95)) {
    errors.push(`[animation] crushed can free-pose deformation is invalid: ${JSON.stringify(diagnostics.crushedCans)}`);
  }
  if (diagnostics.missingSharedMaterials.length) {
    errors.push(`[resources] shared materials disappeared: ${diagnostics.missingSharedMaterials.join(', ')}`);
  }
  if (diagnostics.qualityTier !== 'HIGH') {
    errors.push(`[quality] desktop tier should report HIGH, got ${diagnostics.qualityTier}`);
  }
}

await page.screenshot({ path: 'screenshots/yard.png', fullPage: true });

if (ready) {
  await page.locator('[data-floor="office"]').click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'screenshots/office.png', fullPage: true });

  await page.locator('[data-floor="yard"]').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'screenshots/yard-interaction.png', fullPage: true });
}

await writeFile('screenshots/browser-errors.txt', errors.length ? errors.join('\n') : 'No browser errors captured.\n');
console.log(`Capture completed. ready=${ready}; browserErrors=${errors.length}`);
await browser.close();
if (errors.length) process.exitCode = 2;
