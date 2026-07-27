export type BusinessMode = "direct" | "process";
export type RatType = "runner" | "hauler" | "broker" | "engineer";
export type BrandId = "malt" | "fizz" | "nova" | "orbit";

export interface Roster {
  runner: number;
  hauler: number;
  broker: number;
  engineer: number;
}

export interface ProcessingItem {
  id: string;
  quality: number;
  readyAt: number;
}

export interface PlayerState {
  playerId: string;
  cash: number;
  lifetimeRevenue: number;
  delivered: number;
  mode: BusinessMode;
  roster: Roster;
  processing: ProcessingItem[];
  updatedAt: number;
}

export interface DeliverRequest {
  brandId: BrandId;
  brandMultiplier: number;
  stompMultiplier: number;
  eventId: string;
}

export interface DeliverResponse {
  state: PlayerState;
  acceptedQuality: number;
  revenue: number;
  queued: boolean;
}

export interface HireRequest {
  type: RatType;
}

export interface HireResponse {
  state: PlayerState;
  cost: number;
}

export interface ModeRequest {
  mode: BusinessMode;
}

export interface ApiError {
  error: string;
}
