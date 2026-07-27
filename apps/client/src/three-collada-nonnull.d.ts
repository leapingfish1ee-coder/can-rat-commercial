import type { Group } from "three";

declare module "three/addons/loaders/ColladaLoader.js" {
  interface Collada {
    scene: Group;
  }

  interface ColladaLoader {
    loadAsync(
      url: string,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
    ): Promise<Collada>;
  }
}
