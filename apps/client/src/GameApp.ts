import {
  AbstractMesh,
  ArcRotateCamera,
  Color3,
  Color4,
  CreateBox,
  CreateCapsule,
  CreateCylinder,
  CreateSphere,
  CreateTorus,
  DirectionalLight,
  Engine,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Observable,
  PBRMaterial,
  PointerEventTypes,
  Quaternion,
  Scene,
  ShadowGenerator,
  TransformNode,
  Vector3,
  WebGPUEngine,
} from "@babylonjs/core";
import type { BrandId, PlayerState } from "@can-rat/shared";
import { api } from "./api";
import { BRANDS, RAT_CONFIG, qualityGrade, weightedBrand, type BrandVisual } from "./gameData";
import { ui } from "./ui";

type Floor = "yard" | "office";
type CanState = "falling" | "settled" | "stomping" | "carried";

interface CanEntity {
  id: string;
  brand: BrandVisual;
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

interface RatEntity {
  id: string;
  type: "runner" | "hauler";
  root: TransformNode;
  speed: number;
  capacity: number;
  state: "seeking" | "toCan" | "returning";
  target?: CanEntity;
  cargo: CanEntity[];
  gait: number;
}

interface Impact {
  mesh: Mesh;
  age: number;
  duration: number;
}

const YARD_Y = 0;
const OFFICE_Y = -9;
const DEPOT = new Vector3(-6.7, 0.28, -4.6);
const FIELD_X = 7.25;
const FIELD_Z = 5.15;
const MAX_CANS = 22;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min);
const damp = (current: number, target: number, lambda: number, dt: number): number =>
  target + (current - target) * Math.exp(-lambda * dt);
const randomId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

export class GameApp {
  private engine!: Engine | WebGPUEngine;
  private scene!: Scene;
  private camera!: ArcRotateCamera;
  private shadow!: ShadowGenerator;
  private state!: PlayerState;
  private floor: Floor = "yard";
  private floorBlend = 0;
  private floorTarget = 0;
  private spawnTimer = 0.3;
  private readonly cans: CanEntity[] = [];
  private readonly rats: RatEntity[] = [];
  private readonly impacts: Impact[] = [];
  private readonly materials = new Map<string, PBRMaterial>();
  private readonly brandMaterials = new Map<BrandId, { body: PBRMaterial; accent: PBRMaterial; cap: PBRMaterial }>();
  private readonly onState = new Observable<PlayerState>();

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async start(): Promise<void> {
    this.engine = await this.createEngine();
    this.scene = new Scene(this.engine);
    this.scene.clearColor = Color4.FromHexString("#ebe9e2ff");
    this.scene.ambientColor = new Color3(0.48, 0.48, 0.45);

    this.configureRendering();
    this.createWorld();
    this.bindInput();

    try {
      this.state = await api.session();
    } catch {
      this.state = {
        playerId: "offline",
        cash: 120,
        lifetimeRevenue: 0,
        delivered: 0,
        mode: "direct",
        roster: { runner: 1, hauler: 0, broker: 0, engineer: 0 },
        processing: [],
        updatedAt: Date.now(),
      };
      ui.showToast("SERVER OFFLINE · LOCAL VISUAL MODE");
    }

    this.onState.add((state) => ui.updateState(state));
    this.onState.notifyObservers(this.state);
    this.syncRats();
    this.setFloor("yard");
    for (let index = 0; index < 7; index += 1) this.spawnCan(true);

    let previous = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.033, Math.max(0.001, (now - previous) / 1000));
      previous = now;
      this.update(dt);
      this.scene.render();
    });

    window.addEventListener("resize", () => {
      this.engine.resize();
      this.updateOrtho();
    });
    window.setInterval(() => void this.refreshState(), 4_000);
    ui.ready();
  }

  async setMode(mode: "direct" | "process"): Promise<void> {
    ui.setBusy(true);
    try {
      this.state = await api.mode(mode);
      this.onState.notifyObservers(this.state);
      ui.showToast(mode === "direct" ? "DIRECT SALE ACTIVE" : "PROCESSING ACTIVE");
    } catch (error) {
      ui.showToast(error instanceof Error ? error.message : "MODE UPDATE FAILED");
    } finally {
      ui.setBusy(false);
    }
  }

  async hire(type: "runner" | "hauler" | "broker" | "engineer"): Promise<void> {
    ui.setBusy(true);
    try {
      const result = await api.hire(type);
      this.state = result.state;
      this.onState.notifyObservers(this.state);
      this.syncRats();
      ui.showToast(`${type.toUpperCase()} HIRED · -¥${result.cost.toLocaleString("zh-CN")}`);
    } catch (error) {
      ui.showToast(error instanceof Error ? error.message : "HIRE FAILED");
    } finally {
      ui.setBusy(false);
    }
  }

  setFloor(floor: Floor): void {
    this.floor = floor;
    this.floorTarget = floor === "office" ? 1 : 0;
    ui.setFloor(floor);
  }

  private async createEngine(): Promise<Engine | WebGPUEngine> {
    const navigatorWithGpu = navigator as Navigator & { gpu?: unknown };
    if (navigatorWithGpu.gpu) {
      try {
        const webgpu = new WebGPUEngine(this.canvas, { antialias: true, adaptToDeviceRatio: true });
        await webgpu.initAsync();
        ui.setRenderer("WEBGPU");
        return webgpu;
      } catch {
        // WebGL fallback below.
      }
    }
    ui.setRenderer("WEBGL 2");
    return new Engine(this.canvas, true, {
      antialias: true,
      stencil: true,
      preserveDrawingBuffer: false,
      adaptToDeviceRatio: true,
    });
  }

  private configureRendering(): void {
    const balanced = window.devicePixelRatio > 1.6 || window.innerWidth < 900;
    ui.setQualityTier(balanced ? "BALANCED" : "HIGH");
    this.engine.setHardwareScalingLevel(balanced ? Math.min(1.45, window.devicePixelRatio) : 1);

    this.camera = new ArcRotateCamera("camera", -Math.PI / 4, 0.93, 22, Vector3.Zero(), this.scene);
    this.camera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA;
    this.camera.inputs.clear();
    this.updateOrtho();

    const ambient = new HemisphericLight("ambient", new Vector3(0.2, 1, -0.2), this.scene);
    ambient.intensity = 1.25;
    ambient.diffuse = Color3.FromHexString("#fffdf7");
    ambient.groundColor = Color3.FromHexString("#bdbab0");

    const sun = new DirectionalLight("sun", new Vector3(-0.48, -1, 0.32), this.scene);
    sun.position.set(9, 15, -9);
    sun.intensity = 2.15;
    this.shadow = new ShadowGenerator(balanced ? 1024 : 2048, sun);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = balanced ? 16 : 28;
    this.shadow.bias = 0.0007;

    const glow = new GlowLayer("subtle-glow", this.scene, { blurKernelSize: 16 });
    glow.intensity = 0.06;

    const processing = this.scene.imageProcessingConfiguration;
    processing.toneMappingEnabled = true;
    processing.exposure = 1;
    processing.contrast = 1.16;
    processing.vignetteEnabled = true;
    processing.vignetteWeight = 1.05;
    processing.vignetteColor = new Color4(0.08, 0.08, 0.07, 1);

    this.material("paper", "#eeece5", 0.92, 0);
    this.material("office", "#d8d5cc", 0.84, 0);
    this.material("edge", "#151515", 0.78, 0);
    this.material("glass", "#bfc5c4", 0.22, 0, 0.34);
    for (const brand of BRANDS) {
      this.brandMaterials.set(brand.id, {
        body: this.material(`brand-${brand.id}`, brand.bodyHex, 0.38, 0.62),
        accent: this.material(`brand-${brand.id}-accent`, brand.accentHex, 0.3, 0.74),
        cap: this.material(`brand-${brand.id}-cap`, "#dddcd6", 0.22, 0.9),
      });
    }
  }

  private updateOrtho(): void {
    if (!this.camera) return;
    const aspect = this.engine.getRenderWidth() / this.engine.getRenderHeight();
    const vertical = window.innerWidth < 760 ? 8.4 : 7.2;
    this.camera.orthoTop = vertical;
    this.camera.orthoBottom = -vertical;
    this.camera.orthoLeft = -vertical * aspect;
    this.camera.orthoRight = vertical * aspect;
  }

  private material(name: string, hex: string, roughness: number, metallic: number, alpha = 1): PBRMaterial {
    const cached = this.materials.get(name);
    if (cached) return cached;
    const material = new PBRMaterial(name, this.scene);
    material.albedoColor = Color3.FromHexString(hex);
    material.roughness = roughness;
    material.metallic = metallic;
    material.alpha = alpha;
    if (alpha < 1) material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    this.materials.set(name, material);
    return material;
  }

  private edges(mesh: AbstractMesh, width = 0.5): void {
    mesh.enableEdgesRendering();
    mesh.edgesWidth = width;
    mesh.edgesColor = new Color4(0.05, 0.05, 0.05, 0.72);
  }

  private createWorld(): void {
    this.createFloor(YARD_Y, false);
    this.createFloor(OFFICE_Y, true);
    this.createDepot();
    this.createOffice();

    const shaft = CreateCylinder("vertical-core", { height: 8.8, diameter: 0.74, tessellation: 32 }, this.scene);
    shaft.position.set(-7.1, -4.45, -4.9);
    shaft.material = this.materials.get("glass")!;
    this.edges(shaft, 0.35);
    for (const y of [-2.2, -4.5, -6.8]) {
      const ring = CreateTorus(`core-ring-${y}`, { diameter: 1.65, thickness: 0.03, tessellation: 48 }, this.scene);
      ring.position.set(-7.1, y, -4.9);
      ring.rotation.x = Math.PI / 2;
      ring.material = this.materials.get("edge")!;
      ring.isPickable = false;
    }
  }

  private createFloor(y: number, office: boolean): void {
    const slab = CreateBox(`floor-${y}`, { width: 16, depth: 12, height: 0.34 }, this.scene);
    slab.position.y = y - 0.18;
    slab.material = this.materials.get(office ? "office" : "paper")!;
    slab.receiveShadows = true;
    this.edges(slab, 0.7);

    for (let x = -8; x <= 8; x += 1) {
      const line = CreateBox(`grid-x-${y}-${x}`, { width: 0.008, height: 0.012, depth: 12 }, this.scene);
      line.position.set(x, y + 0.012, 0);
      line.material = this.materials.get("edge")!;
      line.visibility = x % 4 === 0 ? 0.2 : 0.08;
      line.isPickable = false;
    }
    for (let z = -6; z <= 6; z += 1) {
      const line = CreateBox(`grid-z-${y}-${z}`, { width: 16, height: 0.012, depth: 0.008 }, this.scene);
      line.position.set(0, y + 0.012, z);
      line.material = this.materials.get("edge")!;
      line.visibility = z % 3 === 0 ? 0.2 : 0.08;
      line.isPickable = false;
    }
  }

  private createDepot(): void {
    const pad = CreateCylinder("depot", { diameter: 1.55, height: 0.12, tessellation: 48 }, this.scene);
    pad.position.set(DEPOT.x, YARD_Y + 0.08, DEPOT.z);
    pad.material = this.materials.get("paper")!;
    pad.receiveShadows = true;
    this.edges(pad, 0.65);
    const ring = CreateTorus("depot-ring", { diameter: 1.04, thickness: 0.055, tessellation: 48 }, this.scene);
    ring.position.set(DEPOT.x, YARD_Y + 0.17, DEPOT.z);
    ring.rotation.x = Math.PI / 2;
    ring.material = this.materials.get("edge")!;
  }

  private createOffice(): void {
    const y = OFFICE_Y;
    const back = CreateBox("office-back", { width: 16, height: 2.8, depth: 0.18 }, this.scene);
    back.position.set(0, y + 1.38, 5.9);
    back.material = this.materials.get("paper")!;
    this.edges(back, 0.45);

    const left = CreateBox("office-left", { width: 0.18, height: 2.8, depth: 12 }, this.scene);
    left.position.set(-7.9, y + 1.38, 0);
    left.material = this.materials.get("paper")!;
    this.edges(left, 0.45);

    const desks: ReadonlyArray<readonly [number, number]> = [[-4.3, -1.8], [-1.4, -1.8], [1.5, -1.8], [4.4, -1.8]];
    for (const [x, z] of desks) {
      const desk = CreateBox(`desk-${x}`, { width: 2.1, height: 0.12, depth: 1.05 }, this.scene);
      desk.position.set(x, y + 0.78, z);
      desk.material = this.materials.get("paper")!;
      this.edges(desk, 0.35);
      this.shadow.addShadowCaster(desk);
      const terminal = CreateBox(`terminal-${x}`, { width: 0.72, height: 0.52, depth: 0.08 }, this.scene);
      terminal.position.set(x, y + 1.12, z + 0.08);
      terminal.rotation.x = -0.12;
      terminal.material = this.materials.get("glass")!;
      this.edges(terminal, 0.25);
    }

    const processor = CreateBox("processor", { width: 3.2, height: 2, depth: 1.25 }, this.scene);
    processor.position.set(5.6, y + 1, 3.7);
    processor.material = this.materials.get("office")!;
    this.edges(processor, 0.7);
    this.shadow.addShadowCaster(processor);
  }

  private spawnCan(initial = false): void {
    if (this.cans.length >= MAX_CANS) return;
    const brand = weightedBrand();
    const materials = this.brandMaterials.get(brand.id)!;
    const root = new TransformNode(randomId("can"), this.scene);

    const body = CreateCylinder(`${root.name}-body`, { height: 0.62, diameter: 0.29, tessellation: 24 }, this.scene);
    body.parent = root;
    body.material = materials.body;
    body.metadata = { kind: "can", id: root.name };
    this.edges(body, 0.55);
    this.shadow.addShadowCaster(body);

    const accent = CreateCylinder(`${root.name}-accent`, {
      height: brand.pattern === 0 ? 0.12 : 0.08,
      diameter: 0.302,
      tessellation: 24,
    }, this.scene);
    accent.parent = root;
    accent.position.y = brand.pattern === 1 ? -0.13 : brand.pattern === 3 ? 0.14 : 0;
    accent.material = materials.accent;
    accent.metadata = { kind: "can", id: root.name };

    const top = CreateCylinder(`${root.name}-top`, { height: 0.018, diameter: 0.245, tessellation: 24 }, this.scene);
    top.parent = root;
    top.position.y = 0.315;
    top.material = materials.cap;
    top.metadata = { kind: "can", id: root.name };

    const can: CanEntity = {
      id: root.name,
      brand,
      root,
      state: initial ? "settled" : "falling",
      velocity: new Vector3(randomBetween(-0.7, 0.7), randomBetween(-0.2, 0.5), randomBetween(-0.7, 0.7)),
      spin: new Vector3(randomBetween(-5, 5), randomBetween(-7, 7), randomBetween(-5, 5)),
      bounces: 0,
      stompMultiplier: 1,
      quality: brand.multiplier,
      settledAt: initial ? performance.now() - 2_000 : Number.POSITIVE_INFINITY,
    };

    root.position.set(randomBetween(-FIELD_X, FIELD_X), initial ? 0.34 : randomBetween(4.8, 7.2), randomBetween(-FIELD_Z, FIELD_Z));
    root.rotationQuaternion = Quaternion.FromEulerAngles(0, randomBetween(-Math.PI, Math.PI), 0);
    this.cans.push(can);
    ui.setCanCount(this.cans.length);
  }

  private createRat(type: "runner" | "hauler", index: number): RatEntity {
    const config = RAT_CONFIG[type];
    const root = new TransformNode(randomId(type), this.scene);
    root.position.set(DEPOT.x + (index % 3) * 0.28, 0.25, DEPOT.z + Math.floor(index / 3) * 0.28);
    const ratMaterial = this.material(`rat-${type}`, config.bodyHex, type === "runner" ? 0.58 : 0.72, 0);

    const body = CreateCapsule(`${root.name}-body`, {
      height: type === "hauler" ? 0.72 : 0.62,
      radius: type === "hauler" ? 0.25 : 0.22,
      tessellation: 16,
      subdivisions: 3,
    }, this.scene);
    body.parent = root;
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.18;
    body.material = ratMaterial;
    this.edges(body, 0.45);
    this.shadow.addShadowCaster(body);

    const head = CreateSphere(`${root.name}-head`, { diameter: type === "hauler" ? 0.48 : 0.42, segments: 16 }, this.scene);
    head.parent = root;
    head.position.set(0.34, 0.24, 0);
    head.scaling.set(1.2, 0.9, 0.8);
    head.material = ratMaterial;
    this.edges(head, 0.4);

    const tail = MeshBuilder.CreateTube(`${root.name}-tail`, {
      path: [new Vector3(-0.33, 0.18, 0), new Vector3(-0.62, 0.14, 0.08), new Vector3(-0.9, 0.1, -0.02)],
      radius: 0.018,
      tessellation: 8,
      cap: Mesh.CAP_ALL,
    }, this.scene);
    tail.parent = root;
    tail.material = this.materials.get("edge")!;

    return { id: root.name, type, root, speed: config.speed, capacity: config.capacity, state: "seeking", cargo: [], gait: Math.random() * 6 };
  }

  private syncRats(): void {
    const desired = [
      ...Array.from({ length: this.state.roster.runner }, () => "runner" as const),
      ...Array.from({ length: this.state.roster.hauler }, () => "hauler" as const),
    ];
    while (this.rats.length > desired.length) this.rats.pop()?.root.dispose(false, true);
    for (let index = this.rats.length; index < desired.length; index += 1) this.rats.push(this.createRat(desired[index]!, index));
  }

  private bindInput(): void {
    window.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) > 3) this.setFloor(event.deltaY > 0 ? "office" : "yard");
    }, { passive: true });

    this.scene.onPointerObservable.add((pointerInfo: any) => {
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN || this.floor !== "yard") return;
      const pick = pointerInfo.pickInfo;
      const id = pick?.pickedMesh?.metadata?.id as string | undefined;
      if (!id || pick?.pickedMesh?.metadata?.kind !== "can") return;
      const can = this.cans.find((candidate) => candidate.id === id);
      if (!can || can.state !== "settled" || can.claimedBy) return;
      const center = can.root.getAbsolutePosition();
      const point = pick.pickedPoint as Vector3 | undefined;
      const distance = point ? Vector3.Distance(new Vector3(point.x, center.y, point.z), center) : 0.2;
      this.stomp(can, clamp(1 - distance / 0.34, 0, 1));
    });
  }

  private stomp(can: CanEntity, accuracy: number): void {
    can.state = "stomping";
    const alignment = clamp(accuracy * 0.82 + Math.random() * 0.18 + randomBetween(-0.12, 0.12), 0, 1);
    const perfection = Math.round(18 + 82 * Math.pow(alignment, 0.72));
    let range: readonly [number, number];
    let label: string;
    if (perfection >= 95) { range = [1.55, 1.82]; label = "VERTICAL"; }
    else if (perfection >= 82) { range = [1.28, 1.52]; label = "PRECISE"; }
    else if (perfection >= 65) { range = [1.06, 1.28]; label = "CLEAN"; }
    else if (perfection >= 44) { range = [0.9, 1.08]; label = "OFF-AXIS"; }
    else { range = [0.66, 0.92]; label = "MISALIGNED"; }

    can.stompMultiplier = randomBetween(range[0], range[1]);
    can.quality = can.brand.multiplier * can.stompMultiplier;
    const foot = CreateBox(`foot-${can.id}`, { width: 0.62, height: 0.16, depth: 0.88 }, this.scene);
    foot.position.copyFrom(can.root.position);
    foot.position.y += 2.3;
    foot.material = this.materials.get("edge")!;
    this.shadow.addShadowCaster(foot);

    const start = performance.now();
    const startY = foot.position.y;
    const animate = (): void => {
      const t = clamp((performance.now() - start) / 470, 0, 1);
      if (t < 0.38) foot.position.y = startY + (0.46 - startY) * (1 - Math.pow(1 - t / 0.38, 3));
      else {
        foot.position.y = 0.46 + Math.sin(((t - 0.38) / 0.62) * Math.PI) * 0.14;
        can.root.scaling.x = damp(can.root.scaling.x, 1.62, 15, 1 / 60);
        can.root.scaling.y = damp(can.root.scaling.y, 0.18, 18, 1 / 60);
        can.root.scaling.z = damp(can.root.scaling.z, 1.18, 15, 1 / 60);
        can.root.rotationQuaternion = Quaternion.FromEulerAngles(Math.PI / 2, randomBetween(-0.16, 0.16), 0);
      }
      if (t < 1) requestAnimationFrame(animate);
      else {
        foot.dispose(false, true);
        can.state = "settled";
        this.createImpact(can.root.position, 1);
        ui.showToast(`${label} · QUALITY ${qualityGrade(can.quality)}`);
      }
    };
    requestAnimationFrame(animate);
  }

  private update(dt: number): void {
    this.floorBlend = damp(this.floorBlend, this.floorTarget, 5.6, dt);
    this.camera.target.y = YARD_Y + (OFFICE_Y - YARD_Y) * this.floorBlend;
    this.camera.alpha = -Math.PI / 4 + Math.sin(this.floorBlend * Math.PI) * 0.015;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnCan();
      this.spawnTimer = randomBetween(1, 1.75);
    }
    this.updateCans(dt);
    this.updateRats(dt);
    this.updateImpacts(dt);
    ui.setCanCount(this.cans.length);
  }

  private updateCans(dt: number): void {
    for (const can of this.cans) {
      if (can.state !== "falling") continue;
      can.velocity.y -= 13.5 * dt;
      can.root.position.addInPlace(can.velocity.scale(dt));
      can.root.position.x = clamp(can.root.position.x, -FIELD_X, FIELD_X);
      can.root.position.z = clamp(can.root.position.z, -FIELD_Z, FIELD_Z);
      const current = can.root.rotationQuaternion ?? Quaternion.Identity();
      can.root.rotationQuaternion = Quaternion.FromEulerAngles(can.spin.x * dt, can.spin.y * dt, can.spin.z * dt).multiply(current);

      if (can.root.position.y <= 0.34) {
        can.root.position.y = 0.34;
        can.bounces += 1;
        this.createImpact(can.root.position, can.bounces === 1 ? 0.82 : 0.46);
        if (can.bounces >= 3 || Math.abs(can.velocity.y) < 1.15) {
          can.velocity.setAll(0);
          can.spin.setAll(0);
          can.root.rotationQuaternion = Quaternion.FromEulerAngles(0, can.root.rotationQuaternion.toEulerAngles().y, 0);
          can.state = "settled";
          can.settledAt = performance.now();
        } else {
          can.velocity.y = Math.abs(can.velocity.y) * (can.bounces === 1 ? 0.34 : 0.22);
          can.velocity.x *= 0.54;
          can.velocity.z *= 0.54;
          can.spin.scaleInPlace(0.46);
        }
      }
    }
  }

  private updateRats(dt: number): void {
    for (const rat of this.rats) {
      rat.gait += dt * (6 + rat.speed * 2);
      if (rat.state === "seeking") {
        rat.target = this.chooseCan(rat);
        if (rat.target) {
          rat.target.claimedBy = rat.id;
          rat.state = "toCan";
        } else if (rat.cargo.length > 0) rat.state = "returning";
      }
      if (rat.state === "toCan" && rat.target) {
        if (this.moveRat(rat, rat.target.root.position, dt)) this.pickup(rat, rat.target);
      } else if (rat.state === "returning") {
        if (this.moveRat(rat, DEPOT, dt)) void this.deposit(rat);
      } else rat.root.position.y = 0.25 + Math.sin(rat.gait) * 0.015;
    }
  }

  private chooseCan(rat: RatEntity): CanEntity | undefined {
    let best: CanEntity | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const can of this.cans) {
      if (can.state !== "settled" || can.claimedBy || performance.now() - can.settledAt < 850) continue;
      const score = Vector3.Distance(rat.root.position, can.root.position) / (1 + can.brand.multiplier * 0.34);
      if (score < bestScore) { best = can; bestScore = score; }
    }
    return best;
  }

  private moveRat(rat: RatEntity, destination: Vector3, dt: number): boolean {
    const delta = new Vector3(destination.x - rat.root.position.x, 0, destination.z - rat.root.position.z);
    const distance = delta.length();
    if (distance < 0.34) return true;
    const direction = delta.scale(1 / Math.max(distance, 0.0001));
    rat.root.position.addInPlace(direction.scale(Math.min(distance, rat.speed * dt)));
    rat.root.position.y = 0.25 + Math.abs(Math.sin(rat.gait)) * 0.04;
    rat.root.rotation.y = Math.atan2(direction.z, direction.x);
    return false;
  }

  private pickup(rat: RatEntity, can: CanEntity): void {
    can.state = "carried";
    can.claimedBy = rat.id;
    rat.cargo.push(can);
    can.root.parent = rat.root;
    can.root.position.set(-0.15 - rat.cargo.length * 0.15, 0.62, 0);
    if (can.stompMultiplier === 1) can.root.scaling.setAll(0.72);
    else can.root.scaling.set(1, 0.16, 0.74);
    rat.target = undefined;
    rat.state = rat.cargo.length >= rat.capacity ? "returning" : "seeking";
  }

  private async deposit(rat: RatEntity): Promise<void> {
    const cargo = rat.cargo.splice(0);
    rat.state = "seeking";
    for (const can of cargo) {
      try {
        const response = await api.deliver({
          brandId: can.brand.id,
          brandMultiplier: can.brand.multiplier,
          stompMultiplier: can.stompMultiplier,
          eventId: randomId("delivery"),
        });
        this.state = response.state;
        this.onState.notifyObservers(this.state);
        ui.showToast(response.queued
          ? `QUALITY ${qualityGrade(response.acceptedQuality)} · PROCESSING`
          : `QUALITY ${qualityGrade(response.acceptedQuality)} · +¥${response.revenue}`);
      } catch {
        ui.showToast(`QUALITY ${qualityGrade(can.quality)} · LOCAL DELIVERY`);
      }
      const index = this.cans.indexOf(can);
      if (index >= 0) this.cans.splice(index, 1);
      can.root.dispose(false, true);
    }
    this.createImpact(DEPOT, 1.2);
  }

  private createImpact(position: Vector3, size: number): void {
    const ring = CreateTorus(randomId("impact"), { diameter: 0.34, thickness: 0.018, tessellation: 40 }, this.scene);
    ring.position.set(position.x, 0.035, position.z);
    ring.rotation.x = Math.PI / 2;
    ring.material = this.materials.get("edge")!;
    ring.scaling.setAll(size);
    ring.isPickable = false;
    this.impacts.push({ mesh: ring, age: 0, duration: 0.48 });
  }

  private updateImpacts(dt: number): void {
    for (let index = this.impacts.length - 1; index >= 0; index -= 1) {
      const impact = this.impacts[index]!;
      impact.age += dt;
      const t = clamp(impact.age / impact.duration, 0, 1);
      impact.mesh.scaling.setAll(1 + (1 - Math.pow(1 - t, 3)) * 4.2);
      impact.mesh.visibility = Math.pow(1 - t, 2);
      if (t >= 1) {
        impact.mesh.dispose();
        this.impacts.splice(index, 1);
      }
    }
  }

  private async refreshState(): Promise<void> {
    try {
      this.state = await api.session();
      this.onState.notifyObservers(this.state);
      this.syncRats();
    } catch {
      // Keep local rendering alive during transient network loss.
    }
  }
}
