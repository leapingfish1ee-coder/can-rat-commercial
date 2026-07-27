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
const FLOOR_WIDTH = 14.4;
const FLOOR_DEPTH = 10.4;
const FIELD_X = 6.25;
const FIELD_Z = 4.35;
const DEPOT = new Vector3(-5.55, 0.28, -3.55);
const MAX_CANS = 20;

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
  private yardRoot!: TransformNode;
  private officeRoot!: TransformNode;
  private coreRoot!: TransformNode;
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
    this.scene.clearColor = Color4.FromHexString("#d8d6cfff");
    this.scene.ambientColor = Color3.FromHexString("#67645d");

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
    this.engine.setHardwareScalingLevel(balanced ? Math.min(1.35, window.devicePixelRatio) : 1);

    this.camera = new ArcRotateCamera("camera", -Math.PI / 4, 0.91, 22, Vector3.Zero(), this.scene);
    this.camera.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA;
    this.camera.inputs.clear();
    this.updateOrtho();

    const ambient = new HemisphericLight("ambient", new Vector3(0.1, 1, -0.2), this.scene);
    ambient.intensity = 0.72;
    ambient.diffuse = Color3.FromHexString("#f3f0e7");
    ambient.groundColor = Color3.FromHexString("#77736a");

    const sun = new DirectionalLight("sun", new Vector3(-0.48, -1, 0.32), this.scene);
    sun.position.set(8, 15, -10);
    sun.intensity = 1.72;
    this.shadow = new ShadowGenerator(balanced ? 1024 : 2048, sun);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = balanced ? 18 : 30;
    this.shadow.bias = 0.0006;
    this.shadow.darkness = 0.28;

    const glow = new GlowLayer("subtle-glow", this.scene, { blurKernelSize: 20 });
    glow.intensity = 0.035;

    const processing = this.scene.imageProcessingConfiguration;
    processing.toneMappingEnabled = true;
    processing.exposure = 0.86;
    processing.contrast = 1.28;
    processing.vignetteEnabled = true;
    processing.vignetteWeight = 1.32;
    processing.vignetteStretch = 0.18;
    processing.vignetteColor = new Color4(0.07, 0.065, 0.055, 1);

    this.material("paper", "#d9d6cd", 0.9, 0.01);
    this.material("paper-raised", "#eeeae0", 0.82, 0.01);
    this.material("office", "#c5c2b8", 0.78, 0.02);
    this.material("edge", "#1c1b18", 0.72, 0.02);
    this.material("rubber", "#292824", 0.96, 0.0);
    this.material("glass", "#9ca7a4", 0.18, 0.08, 0.48);
    this.material("yard-mark", "#8d8779", 0.82, 0.0);
    this.material("office-green", "#607b70", 0.55, 0.06);
    this.material("office-blue", "#607684", 0.5, 0.08);
    this.material("office-violet", "#76667d", 0.52, 0.05);
    this.material("warm-light", "#b7925d", 0.32, 0.12);
    this.materials.get("warm-light")!.emissiveColor = Color3.FromHexString("#6f512a");

    for (const brand of BRANDS) {
      this.brandMaterials.set(brand.id, {
        body: this.material(`brand-${brand.id}`, brand.bodyHex, 0.34, 0.52),
        accent: this.material(`brand-${brand.id}-accent`, brand.accentHex, 0.3, 0.65),
        cap: this.material(`brand-${brand.id}-cap`, "#c8c6c0", 0.2, 0.86),
      });
    }
  }

  private updateOrtho(): void {
    if (!this.camera) return;
    const aspect = this.engine.getRenderWidth() / this.engine.getRenderHeight();
    const vertical = window.innerWidth < 760 ? 7.1 : 5.85;
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

  private edges(mesh: AbstractMesh, width = 0.5, alpha = 0.76): void {
    mesh.enableEdgesRendering();
    mesh.edgesWidth = width;
    mesh.edgesColor = new Color4(0.035, 0.033, 0.03, alpha);
  }

  private attach(mesh: AbstractMesh, root: TransformNode): void {
    mesh.parent = root;
  }

  private createWorld(): void {
    this.yardRoot = new TransformNode("yard-root", this.scene);
    this.officeRoot = new TransformNode("office-root", this.scene);
    this.coreRoot = new TransformNode("vertical-core-root", this.scene);

    this.createFloor(YARD_Y, false);
    this.createFloor(OFFICE_Y, true);
    this.createYardDetails();
    this.createDepot();
    this.createOffice();
    this.createVerticalCore();

    this.officeRoot.setEnabled(false);
    this.coreRoot.setEnabled(false);
  }

  private createFloor(y: number, office: boolean): void {
    const root = office ? this.officeRoot : this.yardRoot;
    const slab = CreateBox(`floor-${y}`, { width: FLOOR_WIDTH, depth: FLOOR_DEPTH, height: 0.34 }, this.scene);
    slab.position.y = y - 0.18;
    slab.material = this.materials.get(office ? "office" : "paper")!;
    slab.receiveShadows = true;
    this.edges(slab, 0.82, 0.9);
    this.attach(slab, root);

    const halfW = FLOOR_WIDTH / 2;
    const halfD = FLOOR_DEPTH / 2;
    for (let x = -Math.floor(halfW); x <= Math.floor(halfW); x += 1) {
      const line = CreateBox(`grid-x-${y}-${x}`, { width: 0.012, height: 0.014, depth: FLOOR_DEPTH - 0.42 }, this.scene);
      line.position.set(x, y + 0.012, 0);
      line.material = this.materials.get("edge")!;
      line.visibility = x % 4 === 0 ? 0.25 : 0.095;
      line.isPickable = false;
      this.attach(line, root);
    }
    for (let z = -Math.floor(halfD); z <= Math.floor(halfD); z += 1) {
      const line = CreateBox(`grid-z-${y}-${z}`, { width: FLOOR_WIDTH - 0.42, height: 0.014, depth: 0.012 }, this.scene);
      line.position.set(0, y + 0.012, z);
      line.material = this.materials.get("edge")!;
      line.visibility = z % 3 === 0 ? 0.25 : 0.095;
      line.isPickable = false;
      this.attach(line, root);
    }

    for (const [x, z, w, d] of [
      [-halfW + 0.28, 0, 0.09, FLOOR_DEPTH - 0.56],
      [halfW - 0.28, 0, 0.09, FLOOR_DEPTH - 0.56],
      [0, -halfD + 0.28, FLOOR_WIDTH - 0.56, 0.09],
      [0, halfD - 0.28, FLOOR_WIDTH - 0.56, 0.09],
    ] as const) {
      const inset = CreateBox(`inset-${y}-${x}-${z}`, { width: w, height: 0.025, depth: d }, this.scene);
      inset.position.set(x, y + 0.026, z);
      inset.material = this.materials.get("edge")!;
      inset.visibility = 0.54;
      inset.isPickable = false;
      this.attach(inset, root);
    }
  }

  private createYardDetails(): void {
    const markMaterial = this.materials.get("yard-mark")!;
    const root = this.yardRoot;

    for (const z of [-2.55, 0, 2.55]) {
      const lane = CreateBox(`yard-lane-${z}`, { width: 7.5, height: 0.025, depth: 0.055 }, this.scene);
      lane.position.set(1.5, YARD_Y + 0.03, z);
      lane.material = markMaterial;
      lane.visibility = 0.34;
      lane.isPickable = false;
      this.attach(lane, root);
    }

    for (const x of [-2.4, 0.2, 2.8, 5.4]) {
      const marker = CreateBox(`yard-marker-${x}`, { width: 0.62, height: 0.035, depth: 0.09 }, this.scene);
      marker.position.set(x, YARD_Y + 0.04, -4.55);
      marker.material = this.materials.get("edge")!;
      marker.visibility = 0.48;
      marker.isPickable = false;
      this.attach(marker, root);
    }

    const chute = CreateBox("collection-chute", { width: 1.5, height: 0.42, depth: 0.78 }, this.scene);
    chute.position.set(-5.55, YARD_Y + 0.18, -3.55);
    chute.material = this.materials.get("paper-raised")!;
    this.edges(chute, 0.55);
    chute.receiveShadows = true;
    this.shadow.addShadowCaster(chute);
    this.attach(chute, root);
  }

  private createDepot(): void {
    const root = this.yardRoot;
    const pad = CreateCylinder("depot", { diameter: 1.82, height: 0.16, tessellation: 56 }, this.scene);
    pad.position.set(DEPOT.x, YARD_Y + 0.1, DEPOT.z);
    pad.material = this.materials.get("paper-raised")!;
    pad.receiveShadows = true;
    this.edges(pad, 0.72);
    this.attach(pad, root);

    const darkWell = CreateCylinder("depot-well", { diameter: 0.84, height: 0.07, tessellation: 48 }, this.scene);
    darkWell.position.set(DEPOT.x, YARD_Y + 0.205, DEPOT.z);
    darkWell.material = this.materials.get("rubber")!;
    this.attach(darkWell, root);

    const ring = CreateTorus("depot-ring", { diameter: 1.28, thickness: 0.055, tessellation: 56 }, this.scene);
    ring.position.set(DEPOT.x, YARD_Y + 0.23, DEPOT.z);
    ring.material = this.materials.get("edge")!;
    ring.isPickable = false;
    this.attach(ring, root);

    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      const tick = CreateBox(`depot-tick-${index}`, { width: 0.08, height: 0.045, depth: 0.24 }, this.scene);
      tick.position.set(DEPOT.x + Math.cos(angle) * 0.77, YARD_Y + 0.23, DEPOT.z + Math.sin(angle) * 0.77);
      tick.rotation.y = -angle;
      tick.material = this.materials.get("edge")!;
      tick.visibility = 0.72;
      tick.isPickable = false;
      this.attach(tick, root);
    }
  }

  private createVerticalCore(): void {
    const shaft = CreateCylinder("vertical-core", { height: 8.5, diameter: 0.55, tessellation: 28 }, this.scene);
    shaft.position.set(-6.35, -4.45, -4.15);
    shaft.material = this.materials.get("glass")!;
    this.edges(shaft, 0.3, 0.35);
    this.attach(shaft, this.coreRoot);

    for (const y of [-2.15, -4.5, -6.85]) {
      const ring = CreateTorus(`core-ring-${y}`, { diameter: 1.05, thickness: 0.035, tessellation: 40 }, this.scene);
      ring.position.set(-6.35, y, -4.15);
      ring.material = this.materials.get("edge")!;
      ring.visibility = 0.62;
      ring.isPickable = false;
      this.attach(ring, this.coreRoot);
    }
  }

  private createOffice(): void {
    const y = OFFICE_Y;
    const root = this.officeRoot;

    const back = CreateBox("office-back", { width: FLOOR_WIDTH, height: 2.85, depth: 0.18 }, this.scene);
    back.position.set(0, y + 1.4, FLOOR_DEPTH / 2 - 0.14);
    back.material = this.materials.get("paper-raised")!;
    this.edges(back, 0.5);
    this.attach(back, root);

    const left = CreateBox("office-left", { width: 0.18, height: 2.85, depth: FLOOR_DEPTH }, this.scene);
    left.position.set(-FLOOR_WIDTH / 2 + 0.14, y + 1.4, 0);
    left.material = this.materials.get("paper-raised")!;
    this.edges(left, 0.5);
    this.attach(left, root);

    const darkBand = CreateBox("office-brand-band", { width: 8.7, height: 0.14, depth: 0.06 }, this.scene);
    darkBand.position.set(-1.3, y + 2.28, FLOOR_DEPTH / 2 - 0.25);
    darkBand.material = this.materials.get("edge")!;
    darkBand.visibility = 0.78;
    this.attach(darkBand, root);

    const zoneColors = ["office-green", "office-blue", "office-violet", "office-green"] as const;
    const desks: ReadonlyArray<readonly [number, number]> = [[-4.7, -2.0], [-2.25, -2.0], [0.2, -2.0], [2.65, -2.0]];
    for (let index = 0; index < desks.length; index += 1) {
      const [x, z] = desks[index]!;
      const desk = CreateBox(`desk-${x}`, { width: 1.9, height: 0.13, depth: 0.92 }, this.scene);
      desk.position.set(x, y + 0.78, z);
      desk.material = this.materials.get("paper-raised")!;
      this.edges(desk, 0.4);
      this.shadow.addShadowCaster(desk);
      this.attach(desk, root);

      for (const dx of [-0.72, 0.72]) {
        const leg = CreateBox(`desk-leg-${index}-${dx}`, { width: 0.07, height: 0.72, depth: 0.07 }, this.scene);
        leg.position.set(x + dx, y + 0.39, z);
        leg.material = this.materials.get("edge")!;
        this.attach(leg, root);
      }

      const terminal = CreateBox(`terminal-${x}`, { width: 0.67, height: 0.46, depth: 0.08 }, this.scene);
      terminal.position.set(x, y + 1.13, z + 0.08);
      terminal.rotation.x = -0.12;
      terminal.material = this.materials.get(zoneColors[index]!)!;
      this.edges(terminal, 0.28);
      this.attach(terminal, root);

      const keyboard = CreateBox(`keyboard-${x}`, { width: 0.62, height: 0.035, depth: 0.26 }, this.scene);
      keyboard.position.set(x, y + 0.87, z - 0.18);
      keyboard.material = this.materials.get("edge")!;
      keyboard.visibility = 0.72;
      this.attach(keyboard, root);

      this.createOfficeWorker(x, z - 0.72, zoneColors[index]!);
    }

    const processor = CreateBox("processor", { width: 2.6, height: 2.2, depth: 1.35 }, this.scene);
    processor.position.set(5.25, y + 1.1, 3.3);
    processor.material = this.materials.get("office")!;
    this.edges(processor, 0.8);
    this.shadow.addShadowCaster(processor);
    this.attach(processor, root);

    for (let index = 0; index < 5; index += 1) {
      const slot = CreateBox(`processor-slot-${index}`, { width: 2.0, height: 0.085, depth: 0.055 }, this.scene);
      slot.position.set(5.25, y + 0.45 + index * 0.32, 2.6);
      slot.material = this.materials.get(index === 4 ? "warm-light" : "edge")!;
      slot.visibility = index === 4 ? 1 : 0.72;
      this.attach(slot, root);
    }

    const conveyor = CreateBox("office-conveyor", { width: 5.2, height: 0.18, depth: 0.82 }, this.scene);
    conveyor.position.set(2.0, y + 0.42, 3.25);
    conveyor.material = this.materials.get("rubber")!;
    this.edges(conveyor, 0.5);
    this.attach(conveyor, root);

    for (let index = 0; index < 7; index += 1) {
      const roller = CreateCylinder(`roller-${index}`, { height: 0.78, diameter: 0.11, tessellation: 16 }, this.scene);
      roller.position.set(-0.25 + index * 0.73, y + 0.54, 3.25);
      roller.rotation.x = Math.PI / 2;
      roller.material = this.materials.get("paper-raised")!;
      this.attach(roller, root);
    }

    const meeting = CreateCylinder("meeting-table", { height: 0.12, diameter: 2.45, tessellation: 48 }, this.scene);
    meeting.position.set(-4.45, y + 0.72, 2.45);
    meeting.material = this.materials.get("paper-raised")!;
    this.edges(meeting, 0.45);
    this.shadow.addShadowCaster(meeting);
    this.attach(meeting, root);

    const meetingCore = CreateCylinder("meeting-core", { height: 0.67, diameter: 0.18, tessellation: 20 }, this.scene);
    meetingCore.position.set(-4.45, y + 0.35, 2.45);
    meetingCore.material = this.materials.get("edge")!;
    this.attach(meetingCore, root);
  }

  private createOfficeWorker(x: number, z: number, accentName: string): void {
    const root = new TransformNode(`office-worker-${x}`, this.scene);
    root.parent = this.officeRoot;
    root.position.set(x, OFFICE_Y + 0.26, z);
    root.rotation.y = Math.PI / 2;

    const body = CreateCapsule(`${root.name}-body`, { height: 0.55, radius: 0.19, tessellation: 14, subdivisions: 2 }, this.scene);
    body.parent = root;
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.17;
    body.material = this.materials.get("paper-raised")!;
    this.edges(body, 0.32);

    const head = CreateSphere(`${root.name}-head`, { diameter: 0.34, segments: 14 }, this.scene);
    head.parent = root;
    head.position.set(0.3, 0.23, 0);
    head.scaling.set(1.15, 0.86, 0.8);
    head.material = this.materials.get("paper-raised")!;
    this.edges(head, 0.3);

    const badge = CreateBox(`${root.name}-badge`, { width: 0.18, height: 0.1, depth: 0.25 }, this.scene);
    badge.parent = root;
    badge.position.set(-0.03, 0.36, 0);
    badge.material = this.materials.get(accentName)!;
  }

  private spawnCan(initial = false): void {
    if (this.cans.length >= MAX_CANS) return;
    const brand = weightedBrand();
    const materials = this.brandMaterials.get(brand.id)!;
    const root = new TransformNode(randomId("can"), this.scene);
    root.parent = this.yardRoot;

    const body = CreateCylinder(`${root.name}-body`, { height: 0.78, diameter: 0.39, tessellation: 28 }, this.scene);
    body.parent = root;
    body.material = materials.body;
    body.metadata = { kind: "can", id: root.name };
    this.edges(body, 0.68);
    this.shadow.addShadowCaster(body);

    const accentPositions = brand.pattern === 3 ? [-0.18, 0.18] : brand.pattern === 1 ? [-0.2, 0.04] : [0];
    for (let index = 0; index < accentPositions.length; index += 1) {
      const accent = CreateCylinder(`${root.name}-accent-${index}`, {
        height: brand.pattern === 0 ? 0.15 : 0.095,
        diameter: 0.402,
        tessellation: 28,
      }, this.scene);
      accent.parent = root;
      accent.position.y = accentPositions[index]!;
      accent.material = materials.accent;
      accent.metadata = { kind: "can", id: root.name };
    }

    for (const [suffix, y] of [["top", 0.397], ["bottom", -0.397]] as const) {
      const rim = CreateTorus(`${root.name}-${suffix}-rim`, { diameter: 0.34, thickness: 0.025, tessellation: 28 }, this.scene);
      rim.parent = root;
      rim.position.y = y;
      rim.material = materials.cap;
      rim.metadata = { kind: "can", id: root.name };
    }

    const top = CreateCylinder(`${root.name}-top`, { height: 0.022, diameter: 0.305, tessellation: 28 }, this.scene);
    top.parent = root;
    top.position.y = 0.397;
    top.material = materials.cap;
    top.metadata = { kind: "can", id: root.name };

    const tab = CreateTorus(`${root.name}-tab`, { diameter: 0.105, thickness: 0.012, tessellation: 18 }, this.scene);
    tab.parent = root;
    tab.position.set(0.035, 0.414, 0);
    tab.scaling.z = 0.55;
    tab.material = this.materials.get("edge")!;
    tab.metadata = { kind: "can", id: root.name };

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

    root.position.set(randomBetween(-FIELD_X, FIELD_X), initial ? 0.44 : randomBetween(4.8, 7.2), randomBetween(-FIELD_Z, FIELD_Z));
    root.rotationQuaternion = Quaternion.FromEulerAngles(0, randomBetween(-Math.PI, Math.PI), 0);
    this.cans.push(can);
    ui.setCanCount(this.cans.length);
  }

  private createRat(type: "runner" | "hauler", index: number): RatEntity {
    const config = RAT_CONFIG[type];
    const root = new TransformNode(randomId(type), this.scene);
    root.parent = this.yardRoot;
    root.position.set(DEPOT.x + (index % 3) * 0.34, 0.28, DEPOT.z + Math.floor(index / 3) * 0.34);
    const ratMaterial = this.material(`rat-${type}`, config.bodyHex, type === "runner" ? 0.52 : 0.66, 0.02);
    const accentMaterial = this.materials.get(type === "runner" ? "office-green" : "office-violet")!;

    const body = CreateCapsule(`${root.name}-body`, {
      height: type === "hauler" ? 0.88 : 0.76,
      radius: type === "hauler" ? 0.29 : 0.25,
      tessellation: 18,
      subdivisions: 3,
    }, this.scene);
    body.parent = root;
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.22;
    body.material = ratMaterial;
    this.edges(body, 0.52);
    this.shadow.addShadowCaster(body);

    const head = CreateSphere(`${root.name}-head`, { diameter: type === "hauler" ? 0.52 : 0.46, segments: 18 }, this.scene);
    head.parent = root;
    head.position.set(0.42, 0.29, 0);
    head.scaling.set(1.28, 0.9, 0.82);
    head.material = ratMaterial;
    this.edges(head, 0.48);
    this.shadow.addShadowCaster(head);

    for (const z of [-0.16, 0.16]) {
      const ear = CreateSphere(`${root.name}-ear-${z}`, { diameter: 0.19, segments: 14 }, this.scene);
      ear.parent = root;
      ear.position.set(0.31, 0.49, z);
      ear.scaling.set(0.85, 0.45, 1);
      ear.material = ratMaterial;
      this.edges(ear, 0.28);
    }

    for (const z of [-0.105, 0.105]) {
      const eye = CreateSphere(`${root.name}-eye-${z}`, { diameter: 0.055, segments: 10 }, this.scene);
      eye.parent = root;
      eye.position.set(0.61, 0.34, z);
      eye.material = this.materials.get("edge")!;
    }

    const nose = CreateSphere(`${root.name}-nose`, { diameter: 0.075, segments: 10 }, this.scene);
    nose.parent = root;
    nose.position.set(0.69, 0.27, 0);
    nose.material = this.materials.get("edge")!;

    const harness = CreateBox(`${root.name}-harness`, { width: 0.28, height: 0.12, depth: 0.5 }, this.scene);
    harness.parent = root;
    harness.position.set(-0.06, 0.46, 0);
    harness.material = accentMaterial;
    this.edges(harness, 0.25);

    const tail = MeshBuilder.CreateTube(`${root.name}-tail`, {
      path: [new Vector3(-0.4, 0.2, 0), new Vector3(-0.72, 0.15, 0.1), new Vector3(-1.02, 0.09, -0.03)],
      radius: 0.022,
      tessellation: 9,
      cap: Mesh.CAP_ALL,
    }, this.scene);
    tail.parent = root;
    tail.material = this.materials.get("rubber")!;

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
      this.stomp(can, clamp(1 - distance / 0.4, 0, 1));
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
    const foot = CreateBox(`foot-${can.id}`, { width: 0.68, height: 0.18, depth: 0.96 }, this.scene);
    foot.parent = this.yardRoot;
    foot.position.copyFrom(can.root.position);
    foot.position.y += 2.5;
    foot.rotation.y = -0.18;
    foot.material = this.materials.get("rubber")!;
    this.edges(foot, 0.65);
    this.shadow.addShadowCaster(foot);

    const sole = CreateBox(`sole-${can.id}`, { width: 0.72, height: 0.07, depth: 1.01 }, this.scene);
    sole.parent = foot;
    sole.position.y = -0.12;
    sole.material = this.materials.get("edge")!;

    const start = performance.now();
    const startY = foot.position.y;
    let impacted = false;
    const animate = (): void => {
      const t = clamp((performance.now() - start) / 470, 0, 1);
      if (t < 0.38) {
        foot.position.y = startY + (0.55 - startY) * (1 - Math.pow(1 - t / 0.38, 3));
      } else {
        foot.position.y = 0.55 + Math.sin(((t - 0.38) / 0.62) * Math.PI) * 0.12;
        can.root.scaling.x = damp(can.root.scaling.x, 1.72, 17, 1 / 60);
        can.root.scaling.y = damp(can.root.scaling.y, 0.16, 20, 1 / 60);
        can.root.scaling.z = damp(can.root.scaling.z, 1.24, 17, 1 / 60);
        can.root.rotationQuaternion = Quaternion.FromEulerAngles(Math.PI / 2, randomBetween(-0.13, 0.13), randomBetween(-0.05, 0.05));
        if (!impacted) {
          impacted = true;
          this.createImpact(can.root.position, 1.16);
        }
      }
      if (t < 1) requestAnimationFrame(animate);
      else {
        foot.dispose(false, true);
        can.state = "settled";
        ui.showToast(`${label} · QUALITY ${qualityGrade(can.quality)}`);
      }
    };
    requestAnimationFrame(animate);
  }

  private update(dt: number): void {
    this.floorBlend = damp(this.floorBlend, this.floorTarget, 5.2, dt);
    this.camera.target.x = damp(this.camera.target.x, this.floorBlend * -1.3, 5, dt);
    this.camera.target.y = YARD_Y + (OFFICE_Y - YARD_Y) * this.floorBlend;
    this.camera.target.z = damp(this.camera.target.z, this.floorBlend * 0.35, 5, dt);
    this.camera.alpha = -Math.PI / 4 + Math.sin(this.floorBlend * Math.PI) * 0.025;

    this.yardRoot.setEnabled(this.floorBlend < 0.56);
    this.officeRoot.setEnabled(this.floorBlend > 0.44);
    this.coreRoot.setEnabled(this.floorBlend > 0.08 && this.floorBlend < 0.92);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnCan();
      this.spawnTimer = randomBetween(1.05, 1.8);
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

      if (can.root.position.y <= 0.44) {
        can.root.position.y = 0.44;
        can.bounces += 1;
        this.createImpact(can.root.position, can.bounces === 1 ? 0.9 : 0.5);
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
      } else rat.root.position.y = 0.28 + Math.sin(rat.gait) * 0.016;
    }
  }

  private chooseCan(rat: RatEntity): CanEntity | undefined {
    let best: CanEntity | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const can of this.cans) {
      if (can.state !== "settled" || can.claimedBy || performance.now() - can.settledAt < 1_050) continue;
      const score = Vector3.Distance(rat.root.position, can.root.position) / (1 + can.brand.multiplier * 0.34);
      if (score < bestScore) { best = can; bestScore = score; }
    }
    return best;
  }

  private moveRat(rat: RatEntity, destination: Vector3, dt: number): boolean {
    const delta = new Vector3(destination.x - rat.root.position.x, 0, destination.z - rat.root.position.z);
    const distance = delta.length();
    if (distance < 0.38) return true;
    const direction = delta.scale(1 / Math.max(distance, 0.0001));
    rat.root.position.addInPlace(direction.scale(Math.min(distance, rat.speed * dt)));
    rat.root.position.y = 0.28 + Math.abs(Math.sin(rat.gait)) * 0.055;
    rat.root.rotation.y = Math.atan2(direction.z, direction.x);
    return false;
  }

  private pickup(rat: RatEntity, can: CanEntity): void {
    can.state = "carried";
    can.claimedBy = rat.id;
    rat.cargo.push(can);
    can.root.parent = rat.root;
    can.root.position.set(-0.16 - rat.cargo.length * 0.18, 0.72, 0);
    if (can.stompMultiplier === 1) can.root.scaling.setAll(0.68);
    else can.root.scaling.set(0.95, 0.14, 0.7);
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
    this.createImpact(DEPOT, 1.35);
  }

  private createImpact(position: Vector3, size: number): void {
    const ring = CreateTorus(randomId("impact"), { diameter: 0.38, thickness: 0.022, tessellation: 44 }, this.scene);
    ring.parent = this.yardRoot;
    ring.position.set(position.x, 0.045, position.z);
    ring.material = this.materials.get("edge")!;
    ring.scaling.setAll(size);
    ring.isPickable = false;
    this.impacts.push({ mesh: ring, age: 0, duration: 0.5 });
  }

  private updateImpacts(dt: number): void {
    for (let index = this.impacts.length - 1; index >= 0; index -= 1) {
      const impact = this.impacts[index]!;
      impact.age += dt;
      const t = clamp(impact.age / impact.duration, 0, 1);
      impact.mesh.scaling.setAll(1 + (1 - Math.pow(1 - t, 3)) * 4.6);
      impact.mesh.visibility = Math.pow(1 - t, 2) * 0.72;
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
