import type { BrandId, RatType } from "@can-rat/shared";
export interface BrandVisual {
  id: BrandId;
  weight: number;
  multiplier: number;
  bodyHex: string;
  accentHex: string;
  pattern: 0 | 1 | 2 | 3;
}

export const BRANDS: BrandVisual[] = [
  { id: "malt", weight: 58, multiplier: 0.92, bodyHex: "#d9d2c4", accentHex: "#6f675c", pattern: 0 },
  { id: "fizz", weight: 27, multiplier: 1.16, bodyHex: "#a9bdae", accentHex: "#3f6253", pattern: 1 },
  { id: "nova", weight: 12, multiplier: 1.54, bodyHex: "#9fb8c5", accentHex: "#36576a", pattern: 2 },
  { id: "orbit", weight: 3, multiplier: 2.18, bodyHex: "#b6a2bd", accentHex: "#5c4666", pattern: 3 },
];

export interface RatConfig {
  type: RatType;
  speed: number;
  capacity: number;
  bodyHex: string;
}

export const RAT_CONFIG: Record<"runner" | "hauler", RatConfig> = {
  runner: { type: "runner", speed: 2.3, capacity: 1, bodyHex: "#bdb8ad" },
  hauler: { type: "hauler", speed: 1.72, capacity: 2, bodyHex: "#9f9a90" },
};

export function weightedBrand(): BrandVisual {
  const total = BRANDS.reduce((sum, brand) => sum + brand.weight, 0);
  let cursor = Math.random() * total;
  for (const brand of BRANDS) {
    cursor -= brand.weight;
    if (cursor <= 0) return brand;
  }
  return BRANDS[0]!;
}

export function qualityGrade(quality: number): "D" | "C" | "B" | "A" | "S" {
  if (quality >= 2.65) return "S";
  if (quality >= 2.0) return "A";
  if (quality >= 1.45) return "B";
  if (quality >= 1.0) return "C";
  return "D";
}
