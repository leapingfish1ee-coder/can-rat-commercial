import { Quaternion, TransformNode, Vector3 } from "@babylonjs/core";
import type { GameApp } from "./GameApp";
import { qualityGrade } from "./gameData";
import { ui } from "./ui";

type CanState = "falling" | "settled" | "stomping" | "carried";

interface RuntimeCan {
  id: string;
  root: TransformNode;
  state: CanState;
  velocity: Vector3;
  spin: Vector3;
  bounces: number;
  stompMultiplier: number;
  quality: number;
  settledAt: number;
  claimedBy?: string;
}

interface ContinuousPhysicsDiagnostics {
  frames: number;
  floorContacts: number;
  canContacts: number;
  movingCollectable: number;
  squashAnimations: number;
}

interface GameRuntime {
  cans: RuntimeCan[];
  updateCans: (dt: number) => void;
  stomp: (can: RuntimeCan, accuracy: number) => void;
  createImpact: (position: Vector3, size: number) => void;
  continuousPhysicsDiagnostics?: ContinuousPhysicsDiagnostics;
}

const FIELD_X = 6.25;
const FIELD_Z = 4.35;
const CAN_HALF_HEIGHT = 0.39;
const CAN_RADIUS = 0.195;
const FLOOR_PADDING = 0.028;
const GRAVITY = 13.5;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
const randomBetween = (min: number, max: number): number =>
  min + Math.random() * (max - min);
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

function rotationOf(can: RuntimeCan): Quaternion {
  const rotation = can.root.rotationQuaternion ?? Quaternion.Identity();
  rotation.normalize();
  can.root.rotationQuaternion = rotation;
  return rotation;
}

function verticalAxisMagnitude(rotation: Quaternion): number {
  return Math.abs(1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z));
}

function supportHeight(can: RuntimeCan): number {
  const rotation = rotationOf(can);
  const axisY = verticalAxisMagnitude(rotation);
  const scale = can.root.scaling;
  const halfHeight = CAN_HALF_HEIGHT * Math.max(0.08, Math.abs(scale.y));
  const radius = CAN_RADIUS * Math.max(0.12, Math.abs(scale.x), Math.abs(scale.z));
  const radialContribution = Math.sqrt(Math.max(0, 1 - axisY * axisY)) * radius;
  return FLOOR_PADDING + axisY * halfHeight + radialContribution;
}

function horizontalRadius(can: RuntimeCan): number {
  const rotation = rotationOf(can);
  const axisY = verticalAxisMagnitude(rotation);
  const scale = can.root.scaling;
  const sideRadius = CAN_RADIUS * Math.max(Math.abs(scale.x), Math.abs(scale.z));
  const lyingLength = CAN_HALF_HEIGHT * Math.abs(scale.y) * Math.sqrt(Math.max(0, 1 - axisY * axisY));
  return Math.max(0.17, sideRadius + lyingLength * 0.52);
}

function animateScale(can: RuntimeCan, accuracy: number, onImpact: () => void, onDone: () => void): void {
  const start = performance.now();
  const duration = 620;
  const original = can.root.scaling.clone();
  const finalScale = new Vector3(
    1.48 + accuracy * 0.34,
    0.23 - accuracy * 0.08,
    1.1 + accuracy * 0.2,
  );
  let impacted = false;

  const applyPose = (pose: Vector3): void => {
    can.root.scaling.set(
      original.x * pose.x,
      original.y * pose.y,
      original.z * pose.z,
    );
  };

  const frame = (): void => {
    const t = clamp((performance.now() - start) / duration, 0, 1);
    if (t < 0.16) {
      // Anticipation: the can stretches up and narrows before the hit.
      const q = smoothstep(t / 0.16);
      applyPose(new Vector3(1 - q * 0.08, 1 + q * 0.22, 1 - q * 0.08));
    } else if (t < 0.43) {
      // Contact: aggressive squash with an overshoot, without introducing a boot mesh.
      const q = easeOutBack((t - 0.16) / 0.27);
      applyPose(new Vector3(
        0.92 + (finalScale.x * 1.09 - 0.92) * q,
        1.22 + (finalScale.y * 0.55 - 1.22) * q,
        0.92 + (finalScale.z * 1.08 - 0.92) * q,
      ));
      if (!impacted && t > 0.27) {
        impacted = true;
        onImpact();
      }
    } else if (t < 0.68) {
      // Elastic rebound: a brief secondary stretch sells the metal's cartoon response.
      const q = smoothstep((t - 0.43) / 0.25);
      applyPose(new Vector3(
        finalScale.x * 1.09 + (finalScale.x * 0.9 - finalScale.x * 1.09) * q,
        finalScale.y * 0.55 + (finalScale.y * 1.75 - finalScale.y * 0.55) * q,
        finalScale.z * 1.08 + (finalScale.z * 0.92 - finalScale.z * 1.08) * q,
      ));
    } else {
      const q = easeOutBack((t - 0.68) / 0.32);
      applyPose(new Vector3(
        finalScale.x * 0.9 + (finalScale.x - finalScale.x * 0.9) * q,
        finalScale.y * 1.75 + (finalScale.y - finalScale.y * 1.75) * q,
        finalScale.z * 0.92 + (finalScale.z - finalScale.z * 0.92) * q,
      ));
    }

    if (t < 1) requestAnimationFrame(frame);
    else {
      can.root.scaling.copyFrom(finalScale.multiply(original));
      onDone();
    }
  };

  requestAnimationFrame(frame);
}

/**
 * Keeps every collectible can in the lightweight rigid-body simulation even after
 * its first floor contact. `settled` means collectable, not frozen: friction may
 * bring a can to rest naturally, but later can-can contacts or a squash impulse can
 * wake it again without reconstructing the entity.
 */
export function installContinuousCanPolicy(app: GameApp): void {
  const runtime = app as unknown as GameRuntime;
  runtime.continuousPhysicsDiagnostics = {
    frames: 0,
    floorContacts: 0,
    canContacts: 0,
    movingCollectable: 0,
    squashAnimations: 0,
  };

  runtime.updateCans = (dt: number): void => {
    const diagnostics = runtime.continuousPhysicsDiagnostics;
    if (diagnostics) diagnostics.frames += 1;
    const active = runtime.cans.filter((can) => can.state === "falling" || can.state === "settled");

    for (const can of active) {
      const supportBefore = supportHeight(can);
      const groundedBefore = can.root.position.y <= supportBefore + 0.008 && can.velocity.y <= 0.02;
      if (!groundedBefore) can.velocity.y -= GRAVITY * dt;
      else if (can.velocity.y < 0) can.velocity.y = 0;

      can.root.position.addInPlace(can.velocity.scale(dt));

      const angularSpeed = can.spin.length();
      if (angularSpeed > 0.0001) {
        const current = rotationOf(can);
        const delta = Quaternion.FromEulerAngles(can.spin.x * dt, can.spin.y * dt, can.spin.z * dt);
        can.root.rotationQuaternion = delta.multiply(current);
        can.root.rotationQuaternion.normalize();
      }

      const radius = horizontalRadius(can);
      if (can.root.position.x < -FIELD_X + radius) {
        can.root.position.x = -FIELD_X + radius;
        can.velocity.x = Math.abs(can.velocity.x) * 0.46;
        can.spin.z += can.velocity.x * 0.8;
      } else if (can.root.position.x > FIELD_X - radius) {
        can.root.position.x = FIELD_X - radius;
        can.velocity.x = -Math.abs(can.velocity.x) * 0.46;
        can.spin.z += can.velocity.x * 0.8;
      }
      if (can.root.position.z < -FIELD_Z + radius) {
        can.root.position.z = -FIELD_Z + radius;
        can.velocity.z = Math.abs(can.velocity.z) * 0.46;
        can.spin.x -= can.velocity.z * 0.8;
      } else if (can.root.position.z > FIELD_Z - radius) {
        can.root.position.z = FIELD_Z - radius;
        can.velocity.z = -Math.abs(can.velocity.z) * 0.46;
        can.spin.x -= can.velocity.z * 0.8;
      }

      const support = supportHeight(can);
      if (can.root.position.y <= support) {
        const incoming = Math.max(0, -can.velocity.y);
        can.root.position.y = support;
        if (incoming > 0.32) {
          can.bounces += 1;
          can.velocity.y = incoming * (can.bounces === 1 ? 0.28 : 0.16);
          can.spin.x += can.velocity.z * 0.5;
          can.spin.z -= can.velocity.x * 0.5;
          runtime.createImpact(can.root.position, can.bounces === 1 ? 0.76 : 0.38);
          if (diagnostics) diagnostics.floorContacts += 1;
        } else {
          can.velocity.y = 0;
        }

        const linearFriction = Math.exp(-3.15 * dt);
        const angularFriction = Math.exp(-2.1 * dt);
        can.velocity.x *= linearFriction;
        can.velocity.z *= linearFriction;
        can.spin.scaleInPlace(angularFriction);

        if (can.state === "falling") {
          can.state = "settled";
          can.settledAt = performance.now();
        }
      } else {
        can.velocity.x *= Math.exp(-0.12 * dt);
        can.velocity.z *= Math.exp(-0.12 * dt);
        can.spin.scaleInPlace(Math.exp(-0.08 * dt));
      }

      if (can.state === "settled" && (Math.hypot(can.velocity.x, can.velocity.z) > 0.035 || can.spin.length() > 0.08)) {
        if (diagnostics) diagnostics.movingCollectable += 1;
      }
    }

    // Broad-phase is intentionally O(n²): the yard caps cans at twenty, so this
    // produces more convincing pile interaction without a spatial-index overhead.
    for (let firstIndex = 0; firstIndex < active.length; firstIndex += 1) {
      const first = active[firstIndex]!;
      for (let secondIndex = firstIndex + 1; secondIndex < active.length; secondIndex += 1) {
        const second = active[secondIndex]!;
        if (Math.abs(first.root.position.y - second.root.position.y) > 0.68) continue;

        const dx = second.root.position.x - first.root.position.x;
        const dz = second.root.position.z - first.root.position.z;
        const distanceSquared = dx * dx + dz * dz;
        const minimumDistance = (horizontalRadius(first) + horizontalRadius(second)) * 0.88;
        if (distanceSquared >= minimumDistance * minimumDistance) continue;

        const distance = Math.sqrt(Math.max(distanceSquared, 0.000001));
        const nx = dx / distance;
        const nz = dz / distance;
        const overlap = minimumDistance - distance;
        first.root.position.x -= nx * overlap * 0.5;
        first.root.position.z -= nz * overlap * 0.5;
        second.root.position.x += nx * overlap * 0.5;
        second.root.position.z += nz * overlap * 0.5;

        const relativeNormalVelocity =
          (second.velocity.x - first.velocity.x) * nx +
          (second.velocity.z - first.velocity.z) * nz;
        if (relativeNormalVelocity < 0) {
          const impulse = -(1 + 0.32) * relativeNormalVelocity * 0.5;
          first.velocity.x -= impulse * nx;
          first.velocity.z -= impulse * nz;
          second.velocity.x += impulse * nx;
          second.velocity.z += impulse * nz;
          first.spin.y -= impulse * 1.2;
          second.spin.y += impulse * 1.2;
        }
        if (diagnostics) diagnostics.canContacts += 1;
      }
    }
  };

  runtime.stomp = (can: RuntimeCan, accuracy: number): void => {
    if (can.state !== "settled" || can.claimedBy) return;
    can.state = "stomping";
    const alignment = clamp(accuracy * 0.82 + Math.random() * 0.18 + randomBetween(-0.1, 0.1), 0, 1);
    const perfection = Math.round(18 + 82 * Math.pow(alignment, 0.72));

    let range: readonly [number, number];
    let label: string;
    if (perfection >= 95) { range = [1.55, 1.82]; label = "VERTICAL"; }
    else if (perfection >= 82) { range = [1.28, 1.52]; label = "PRECISE"; }
    else if (perfection >= 65) { range = [1.06, 1.28]; label = "CLEAN"; }
    else if (perfection >= 44) { range = [0.9, 1.08]; label = "OFF-AXIS"; }
    else { range = [0.66, 0.92]; label = "MISALIGNED"; }

    can.stompMultiplier = randomBetween(range[0], range[1]);
    can.quality = (can as RuntimeCan & { brand?: { multiplier: number } }).brand?.multiplier
      ? (can as RuntimeCan & { brand: { multiplier: number } }).brand.multiplier * can.stompMultiplier
      : can.quality * can.stompMultiplier;
    if (runtime.continuousPhysicsDiagnostics) runtime.continuousPhysicsDiagnostics.squashAnimations += 1;

    animateScale(
      can,
      alignment,
      () => {
        runtime.createImpact(can.root.position, 1.08 + alignment * 0.22);
        can.velocity.x += randomBetween(-0.42, 0.42) * (0.65 + alignment);
        can.velocity.z += randomBetween(-0.42, 0.42) * (0.65 + alignment);
        can.spin.x += randomBetween(-2.2, 2.2);
        can.spin.y += randomBetween(-2.8, 2.8);
        can.spin.z += randomBetween(-2.2, 2.2);
      },
      () => {
        // The accumulated quaternion is never overwritten: a crushed can may lie,
        // roll or briefly balance on an edge before friction naturally settles it.
        can.root.position.y = Math.max(can.root.position.y, supportHeight(can) + 0.015);
        can.velocity.y = 0.65 + alignment * 0.62;
        can.state = "settled";
        can.settledAt = performance.now();
        ui.showToast(`${label} · QUALITY ${qualityGrade(can.quality)}`);
      },
    );
  };
}
