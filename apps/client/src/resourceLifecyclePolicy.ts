import { AbstractMesh, TransformNode } from "@babylonjs/core";

interface ResourceLifecycleDiagnostics {
  preventedMaterialDisposals: number;
  protectedNodeNames: string[];
}

type RuntimeGlobal = typeof globalThis & {
  __CAN_RAT_RESOURCE_POLICY_INSTALLED__?: boolean;
  __CAN_RAT_RESOURCE_LIFECYCLE__?: ResourceLifecycleDiagnostics;
};

const dynamicPrefixes = ["can_", "runner_", "hauler_", "foot-"] as const;

function isDynamicEntity(name: string): boolean {
  return dynamicPrefixes.some((prefix) => name.startsWith(prefix));
}

function recordProtection(name: string): void {
  const runtime = globalThis as RuntimeGlobal;
  const diagnostics = runtime.__CAN_RAT_RESOURCE_LIFECYCLE__;
  if (!diagnostics) return;
  diagnostics.preventedMaterialDisposals += 1;
  diagnostics.protectedNodeNames.push(name);
  if (diagnostics.protectedNodeNames.length > 32) diagnostics.protectedNodeNames.shift();
}

/**
 * Babylon's second dispose argument destroys materials and textures recursively.
 * Dynamic cans, temporary stomp meshes and rats all reuse materials from the
 * scene-level material cache, so passing `true` makes unrelated live objects
 * progressively turn white or lose their visual treatment.
 *
 * Keep geometry disposal intact, but prevent shared material disposal only for
 * known short-lived gameplay entities. Scene-wide disposal remains unaffected.
 */
export function installResourceLifecyclePolicy(): void {
  const runtime = globalThis as RuntimeGlobal;
  if (runtime.__CAN_RAT_RESOURCE_POLICY_INSTALLED__) return;
  runtime.__CAN_RAT_RESOURCE_POLICY_INSTALLED__ = true;
  runtime.__CAN_RAT_RESOURCE_LIFECYCLE__ = {
    preventedMaterialDisposals: 0,
    protectedNodeNames: [],
  };

  const meshDispose = AbstractMesh.prototype.dispose;
  AbstractMesh.prototype.dispose = function disposeDynamicMesh(
    this: AbstractMesh,
    doNotRecurse?: boolean,
    disposeMaterialAndTextures?: boolean,
  ): void {
    const protectSharedMaterial = disposeMaterialAndTextures === true && isDynamicEntity(this.name);
    if (protectSharedMaterial) recordProtection(this.name);
    meshDispose.call(this, doNotRecurse, protectSharedMaterial ? false : disposeMaterialAndTextures);
  };

  const transformDispose = TransformNode.prototype.dispose;
  TransformNode.prototype.dispose = function disposeDynamicTransform(
    this: TransformNode,
    doNotRecurse?: boolean,
    disposeMaterialAndTextures?: boolean,
  ): void {
    const protectSharedMaterial = disposeMaterialAndTextures === true && isDynamicEntity(this.name);
    if (protectSharedMaterial) recordProtection(this.name);
    transformDispose.call(this, doNotRecurse, protectSharedMaterial ? false : disposeMaterialAndTextures);
  };
}
