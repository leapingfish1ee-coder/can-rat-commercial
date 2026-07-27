import {
  AbstractMesh,
  ArcRotateCamera,
  Engine,
  FxaaPostProcess,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { GameApp } from "./GameApp";

type CanState = "falling" | "settled" | "stomping" | "carried";

interface RuntimeCan {
  root: TransformNode;
  state: CanState;
  velocity: Vector3;
  spin: Vector3;
  bounces: number;
  settledAt: number;
}

interface GameRuntime {
  configureRendering: () => void;
  edges: (mesh: AbstractMesh, width?: number, alpha?: number) => void;
  updateCans: (dt: number) => void;
  createImpact: (position: Vector3, size: number) => void;
  engine?: Engine;
  scene?: Scene;
  camera?: ArcRotateCamera;
  cans: RuntimeCan[];
  qualityFxaa?: FxaaPostProcess;
}

const FIELD_X = 6.25;
const FIELD_Z = 4.35;
const CAN_HALF_HEIGHT = 0.39;
const CAN_RADIUS = 0.195;
const FLOOR_PADDING = 0.028;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

function supportHeight(rotation: Quaternion): number {
  const normalized = rotation.clone();
  normalized.normalize();
  // Vertical component of the cylinder's local Y axis after quaternion rotation.
  const axisY = Math.abs(1 - 2 * (normalized.x * normalized.x + normalized.z * normalized.z));
  const radialContribution = Math.sqrt(Math.max(0, 1 - axisY * axisY)) * CAN_RADIUS;
  return FLOOR_PADDING + axisY * CAN_HALF_HEIGHT + radialContribution;
}

/**
 * Applies two production-facing corrections without duplicating the scene code:
 * 1. Native-resolution desktop rendering plus FXAA and thinner technical outlines.
 * 2. Orientation-aware can-floor contact that preserves the final physical pose.
 */
export function installQualityPhysicsPolicy(app: GameApp): void {
  const runtime = app as unknown as GameRuntime;

  const configureRendering = runtime.configureRendering.bind(runtime);
  runtime.configureRendering = (): void => {
    configureRendering();
    const mobileLike = window.innerWidth < 900;
    runtime.engine?.setHardwareScalingLevel(mobileLike ? 1.08 : 1);

    if (runtime.camera && runtime.scene) {
      runtime.qualityFxaa?.dispose();
      runtime.qualityFxaa = new FxaaPostProcess(
        "quality-fxaa",
        1,
        runtime.camera,
        undefined,
        runtime.engine,
        false,
      );
    }
  };

  const drawEdges = runtime.edges.bind(runtime);
  runtime.edges = (mesh: AbstractMesh, width = 0.5, alpha = 0.76): void => {
    drawEdges(mesh, Math.max(0.3, width * 0.7), Math.min(alpha, 0.72));
  };

  runtime.updateCans = (dt: number): void => {
    for (const can of runtime.cans) {
      if (can.state !== "falling") continue;

      can.velocity.y -= 13.5 * dt;
      can.root.position.addInPlace(can.velocity.scale(dt));
      can.root.position.x = clamp(can.root.position.x, -FIELD_X, FIELD_X);
      can.root.position.z = clamp(can.root.position.z, -FIELD_Z, FIELD_Z);

      const current = can.root.rotationQuaternion ?? Quaternion.Identity();
      const deltaRotation = Quaternion.FromEulerAngles(
        can.spin.x * dt,
        can.spin.y * dt,
        can.spin.z * dt,
      );
      can.root.rotationQuaternion = deltaRotation.multiply(current);
      can.root.rotationQuaternion.normalize();

      const contactY = supportHeight(can.root.rotationQuaternion);
      if (can.root.position.y > contactY) continue;

      can.root.position.y = contactY;
      can.bounces += 1;
      runtime.createImpact(can.root.position, can.bounces === 1 ? 0.82 : 0.42);

      const incomingSpeed = Math.abs(can.velocity.y);
      const lowEnergy = incomingSpeed < 0.9 && can.spin.length() < 1.45;
      if (can.bounces >= 5 || (can.bounces >= 2 && lowEnergy)) {
        // Do not snap to an upright quaternion. Preserve the orientation produced by
        // gravity, bounce and angular momentum, then place the cylinder on its support hull.
        can.velocity.setAll(0);
        can.spin.setAll(0);
        can.root.position.y = supportHeight(can.root.rotationQuaternion) + 0.002;
        can.state = "settled";
        can.settledAt = performance.now();
        continue;
      }

      const restitution = can.bounces === 1 ? 0.31 : 0.18;
      can.velocity.y = incomingSpeed * restitution;
      can.velocity.x *= 0.57;
      can.velocity.z *= 0.57;

      // Ground friction converts some translation into a small rolling impulse.
      can.spin.x += can.velocity.z * 0.48;
      can.spin.z -= can.velocity.x * 0.48;
      can.spin.scaleInPlace(can.bounces === 1 ? 0.52 : 0.38);
    }
  };
}
