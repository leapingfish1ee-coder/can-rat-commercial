import {
  Camera,
  PBRMaterial,
  Scene,
  ScenePerformancePriority,
  SharpenPostProcess,
} from "@babylonjs/core";
import type { GameApp } from "./GameApp";

interface GameRuntime {
  scene?: Scene;
  camera?: Camera;
  configureRendering: () => void;
  createWorld: () => void;
  sceneSharpen?: SharpenPostProcess;
}

const dynamicPrefixes = ["can_", "runner_", "hauler_", "impact_", "foot-"] as const;
const isDynamic = (name: string): boolean => dynamicPrefixes.some((prefix) => name.startsWith(prefix));

/**
 * Applies conservative commercial-web tuning: balanced scene scheduling,
 * selective static-matrix freezing, pointer-picking reduction and a restrained
 * sharpen pass after FXAA so technical lines stay crisp without haloing.
 */
export function installSceneOptimizationPolicy(app: GameApp): void {
  const runtime = app as unknown as GameRuntime;
  const configureRendering = runtime.configureRendering.bind(runtime);
  runtime.configureRendering = (): void => {
    configureRendering();
    const scene = runtime.scene;
    if (!scene) return;
    scene.performancePriority = ScenePerformancePriority.Intermediate;
    scene.skipPointerMovePicking = true;
    scene.autoClearDepthAndStencil = true;

    if (runtime.camera) {
      runtime.sceneSharpen?.dispose();
      runtime.sceneSharpen = new SharpenPostProcess("scene-sharpen", 1, runtime.camera);
      runtime.sceneSharpen.edgeAmount = 0.17;
      runtime.sceneSharpen.colorAmount = 1.01;
    }

    for (const material of scene.materials) {
      if (material instanceof PBRMaterial) material.environmentIntensity = 0.72;
    }
  };

  const createWorld = runtime.createWorld.bind(runtime);
  runtime.createWorld = (): void => {
    createWorld();
    const scene = runtime.scene;
    if (!scene) return;
    for (const mesh of scene.meshes) {
      if (isDynamic(mesh.name)) continue;
      if (mesh.skeleton || mesh.morphTargetManager) continue;
      mesh.freezeWorldMatrix();
      mesh.doNotSyncBoundingInfo = true;
    }
  };
}
