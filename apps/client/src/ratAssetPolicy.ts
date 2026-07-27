import {
  Color3,
  Mesh,
  PBRMaterial,
  Scene,
  TransformNode,
  VertexData,
} from "@babylonjs/core";
import type { GameApp } from "./GameApp";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import type { BufferGeometry, Mesh as ThreeMesh, Object3D } from "three";

interface RatRuntime {
  id: string;
  type: "runner" | "hauler";
  root: TransformNode;
}

interface GeometryPart {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

interface RatAssetDiagnostics {
  loaded: boolean;
  attached: number;
  failed: number;
  triangles: number;
  source: string;
}

interface GameRuntime {
  scene?: Scene;
  createRat: (type: "runner" | "hauler", index: number) => RatRuntime;
  material: (name: string, hex: string, roughness: number, metallic: number, alpha?: number) => PBRMaterial;
  ratAssetDiagnostics?: RatAssetDiagnostics;
}

function asThreeMesh(object: Object3D): ThreeMesh | undefined {
  const candidate = object as ThreeMesh;
  return candidate.isMesh && candidate.geometry ? candidate : undefined;
}

function extractParts(root: Object3D): GeometryPart[] {
  root.updateMatrixWorld(true);
  const raw: Array<{ geometry: BufferGeometry; positions: number[] }> = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  root.traverse((object) => {
    const source = asThreeMesh(object);
    if (!source) return;
    const geometry = source.geometry.clone();
    geometry.applyMatrix4(source.matrixWorld);
    const attribute = geometry.getAttribute("position");
    if (!attribute) return;
    const positions = Array.from(attribute.array as ArrayLike<number>);
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index]!;
      const y = positions[index + 1]!;
      const z = positions[index + 2]!;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    raw.push({ geometry, positions });
  });

  if (!raw.length) throw new Error("The CC0 Collada asset contains no renderable meshes.");
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.0001);
  const scale = 1.32 / extent;
  const centerX = (minX + maxX) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;

  return raw.map(({ geometry, positions }) => {
    const transformed: number[] = [];
    for (let index = 0; index < positions.length; index += 3) {
      transformed.push(
        (positions[index]! - centerX) * scale,
        (positions[index + 1]! - minY) * scale,
        -(positions[index + 2]! - centerZ) * scale,
      );
    }

    const normalAttribute = geometry.getAttribute("normal");
    const normals = normalAttribute
      ? Array.from(normalAttribute.array as ArrayLike<number>)
      : new Array(transformed.length).fill(0);
    for (let index = 2; index < normals.length; index += 3) normals[index] = -normals[index]!;

    const uvAttribute = geometry.getAttribute("uv");
    const uvs = uvAttribute ? Array.from(uvAttribute.array as ArrayLike<number>) : [];
    const indexAttribute = geometry.getIndex();
    const indices = indexAttribute
      ? Array.from(indexAttribute.array as ArrayLike<number>)
      : Array.from({ length: transformed.length / 3 }, (_, index) => index);
    for (let index = 0; index + 2 < indices.length; index += 3) {
      const temporary = indices[index + 1]!;
      indices[index + 1] = indices[index + 2]!;
      indices[index + 2] = temporary;
    }
    if (!normalAttribute) VertexData.ComputeNormals(transformed, indices, normals);
    return { positions: transformed, normals, uvs, indices };
  });
}

/**
 * Loads the public-domain low-poly rat by br-n518 through the same-origin asset
 * endpoint, converts the Collada BufferGeometry into Babylon meshes, and retains
 * the procedural rat as an automatic fallback for offline development.
 */
export function installRatAssetPolicy(app: GameApp): void {
  const runtime = app as unknown as GameRuntime;
  runtime.ratAssetDiagnostics = {
    loaded: false,
    attached: 0,
    failed: 0,
    triangles: 0,
    source: "OpenGameArt rat-0 / br-n518 / CC0",
  };

  let templatePromise: Promise<GeometryPart[]> | undefined;
  const loadTemplate = (): Promise<GeometryPart[]> => {
    templatePromise ??= new ColladaLoader()
      .loadAsync("/assets/rat.dae")
      .then((asset) => extractParts(asset.scene));
    return templatePromise;
  };

  const createRat = runtime.createRat.bind(runtime);
  runtime.createRat = (type: "runner" | "hauler", index: number): RatRuntime => {
    const rat = createRat(type, index);
    const fallbackMeshes = rat.root.getChildMeshes(false);

    void loadTemplate()
      .then((parts) => {
        const scene = runtime.scene;
        if (!scene || rat.root.isDisposed()) return;
        const group = new TransformNode(`${rat.id}-cc0-asset`, scene);
        group.parent = rat.root;
        group.rotation.y = -Math.PI / 2;
        group.position.set(0.03, 0.02, 0);
        const roleScale = type === "hauler" ? 1.13 : 1;
        group.scaling.setAll(roleScale);

        const materialName = type === "hauler" ? "rat-cc0-hauler" : "rat-cc0-runner";
        const bodyMaterial = runtime.material(
          materialName,
          type === "hauler" ? "#a8a096" : "#c8bdb0",
          0.78,
          0.02,
        );
        bodyMaterial.albedoColor = Color3.FromHexString(type === "hauler" ? "#a8a096" : "#c8bdb0");

        let triangleCount = 0;
        parts.forEach((part, partIndex) => {
          const mesh = new Mesh(`${rat.id}-cc0-part-${partIndex}`, scene);
          const data = new VertexData();
          data.positions = part.positions;
          data.normals = part.normals;
          data.indices = part.indices;
          if (part.uvs.length) data.uvs = part.uvs;
          data.applyToMesh(mesh, true);
          mesh.parent = group;
          mesh.material = bodyMaterial;
          mesh.isPickable = false;
          mesh.receiveShadows = true;
          mesh.enableEdgesRendering(0.985);
          mesh.edgesWidth = 0.28;
          triangleCount += part.indices.length / 3;
        });

        // Preserve the colored role harness while replacing the placeholder body.
        for (const mesh of fallbackMeshes) {
          const keepRoleBadge = mesh.name.includes("harness");
          mesh.setEnabled(keepRoleBadge);
        }

        const diagnostics = runtime.ratAssetDiagnostics;
        if (diagnostics) {
          diagnostics.loaded = true;
          diagnostics.attached += 1;
          diagnostics.triangles = Math.round(triangleCount);
        }
      })
      .catch((error: unknown) => {
        if (runtime.ratAssetDiagnostics) runtime.ratAssetDiagnostics.failed += 1;
        console.warn("[rat-asset] procedural fallback retained:", error);
      });

    return rat;
  };
}
