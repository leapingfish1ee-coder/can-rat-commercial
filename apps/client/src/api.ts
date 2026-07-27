import type {
  BusinessMode,
  DeliverRequest,
  DeliverResponse,
  HireResponse,
  PlayerState,
  RatType,
} from "@can-rat/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

function playerId(): string {
  const key = "can-rat-player-id";
  const current = localStorage.getItem(key);
  if (current) return current;
  const created = `guest_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  localStorage.setItem(key, created);
  return created;
}

async function request<T extends object>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-player-id": playerId(),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    throw new Error(("error" in body && body.error) || `HTTP ${response.status}`);
  }
  return body as T;
}

export const api = {
  session(): Promise<PlayerState> {
    return request<PlayerState>("/api/session");
  },

  deliver(body: DeliverRequest): Promise<DeliverResponse> {
    return request<DeliverResponse>("/api/deliver", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  hire(type: RatType): Promise<HireResponse> {
    return request<HireResponse>("/api/hire", {
      method: "POST",
      body: JSON.stringify({ type }),
    });
  },

  mode(mode: BusinessMode): Promise<PlayerState> {
    return request<PlayerState>("/api/mode", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
  },
};
