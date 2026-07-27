import type { ArcRotateCamera, Engine, TransformNode } from "@babylonjs/core";
import type { GameApp } from "./GameApp";

type Floor = "yard" | "office";

interface GameRuntime {
  floor: Floor;
  update: (dt: number) => void;
  yardRoot?: TransformNode;
  officeRoot?: TransformNode;
  coreRoot?: TransformNode;
  camera?: ArcRotateCamera;
  engine?: Engine;
}

/**
 * Enforces deterministic floor isolation after the simulation update and before
 * Scene.render(). Babylon parent enable-state is not sufficiently reliable for
 * deeply nested, dynamically re-parented cargo meshes across both renderers.
 */
export function installRenderPolicy(app: GameApp): void {
  const runtime = app as unknown as GameRuntime;
  const simulationUpdate = runtime.update.bind(runtime);

  runtime.update = (dt: number): void => {
    simulationUpdate(dt);

    const yardVisible = runtime.floor === "yard";
    const yardRoot = runtime.yardRoot;
    const officeRoot = runtime.officeRoot;

    if (yardRoot && officeRoot) {
      // Keep roots enabled, then control every descendant mesh explicitly.
      yardRoot.setEnabled(true);
      officeRoot.setEnabled(true);
      for (const mesh of yardRoot.getChildMeshes(false)) mesh.setEnabled(yardVisible);
      for (const mesh of officeRoot.getChildMeshes(false)) mesh.setEnabled(!yardVisible);
    }

    // The shaft was useful as a transition prototype, but it competes with the
    // active floor and reads as accidental geometry in the commercial framing.
    runtime.coreRoot?.setEnabled(false);

    const camera = runtime.camera;
    const engine = runtime.engine;
    if (camera && engine) {
      const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
      const vertical = window.innerWidth < 760 ? 7.35 : 6.25;
      camera.orthoTop = vertical;
      camera.orthoBottom = -vertical;
      camera.orthoLeft = -vertical * aspect;
      camera.orthoRight = vertical * aspect;
    }
  };
}
