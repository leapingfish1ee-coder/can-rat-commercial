import type { BusinessMode, PlayerState, RatType } from "@can-rat/shared";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
};

const cash = byId<HTMLElement>("cash");
const revenue = byId<HTMLElement>("revenue");
const queueCount = byId<HTMLElement>("queue-count");
const ratCount = byId<HTMLElement>("rat-count");
const canCount = byId<HTMLElement>("can-count");
const qualityTier = byId<HTMLElement>("quality-tier");
const renderer = byId<HTMLElement>("renderer");
const panel = byId<HTMLElement>("company-panel");
const uiRoot = byId<HTMLElement>("ui");
const qualityLegend = byId<HTMLElement>("quality-legend");
const instructionKey = byId<HTMLElement>("instruction-key");
const instructionText = byId<HTMLElement>("instruction-text");
const toast = byId<HTMLElement>("toast");
const loading = byId<HTMLElement>("loading");

const floorButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-floor]")];
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];
const hireButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-hire]")];

let toastTimer: number | undefined;

function yuan(value: number): string {
  return `¥${Math.floor(value).toLocaleString("zh-CN")}`;
}

export const ui = {
  setRenderer(name: string): void {
    renderer.textContent = name;
  },

  setQualityTier(name: string): void {
    qualityTier.textContent = name;
  },

  ready(): void {
    loading.classList.add("hidden");
  },

  setFloor(floor: "yard" | "office"): void {
    const office = floor === "office";
    uiRoot.dataset.floor = floor;
    panel.classList.toggle("visible", office);
    panel.setAttribute("aria-hidden", String(!office));
    qualityLegend.style.opacity = office ? "0" : "1";
    qualityLegend.style.visibility = office ? "hidden" : "visible";
    floorButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.floor === floor);
    });
    instructionKey.textContent = office ? "HIRE" : "TAP";
    instructionText.textContent = office
      ? "招聘不同类型的老鼠，并选择直售或加工业务。经济结算由服务端执行。"
      : "点击罐体中心以获得更垂直的踩压。品牌由配色区分，最终质量决定销售价格。";
  },

  updateState(state: PlayerState): void {
    cash.textContent = yuan(state.cash);
    revenue.textContent = yuan(state.lifetimeRevenue);
    queueCount.textContent = String(state.processing.length);
    const activeRats = state.roster.runner + state.roster.hauler;
    ratCount.textContent = String(activeRats);

    (Object.keys(state.roster) as RatType[]).forEach((type) => {
      const meta = document.querySelector<HTMLElement>(`[data-meta="${type}"]`);
      if (meta) meta.textContent = `×${state.roster[type]}`;
    });

    modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    });
  },

  setCanCount(value: number): void {
    canCount.textContent = String(value);
  },

  showToast(message: string): void {
    toast.textContent = message;
    toast.classList.add("show");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1500);
  },

  onFloor(callback: (floor: "yard" | "office") => void): void {
    floorButtons.forEach((button) => {
      button.addEventListener("click", () => {
        callback(button.dataset.floor === "office" ? "office" : "yard");
      });
    });
  },

  onMode(callback: (mode: BusinessMode) => void): void {
    modeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        callback(button.dataset.mode === "process" ? "process" : "direct");
      });
    });
  },

  onHire(callback: (type: RatType) => void): void {
    hireButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const type = button.dataset.hire as RatType | undefined;
        if (type) callback(type);
      });
    });
  },

  setBusy(busy: boolean): void {
    modeButtons.forEach((button) => { button.disabled = busy; });
    hireButtons.forEach((button) => { button.disabled = busy; });
  },
};
