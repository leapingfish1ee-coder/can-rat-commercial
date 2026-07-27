# Third-Party Assets

## Rat / 老鼠模型

- Asset: `Rat` (`rat-0`)
- Author: `br-n518`
- Source: OpenGameArt
- Source page: `https://opengameart.org/content/rat-0`
- Archive: `https://opengameart.org/sites/default/files/rat_godot.zip`
- License: CC0 1.0 Universal / Public Domain Dedication
- Included content: low-poly rat mesh, texture, armature and animation data
- Project usage: the client loads the Collada mesh through the game server, converts its geometry into Babylon.js meshes, and applies the project's role materials. The procedural rat remains as an offline fallback.

The asset license permits commercial use, modification and redistribution without attribution. This file preserves provenance for production asset governance.

## Runtime libraries

- Babylon.js — Apache-2.0
- Three.js — MIT; used only as a Collada parsing bridge before geometry is transferred to Babylon.js
- fflate — MIT; used by the server to extract the published CC0 asset archive
