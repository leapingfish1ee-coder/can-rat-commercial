import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Type } from "@sinclair/typebox";
import { strFromU8, unzipSync } from "fflate";
import type {
  BrandId,
  BusinessMode,
  DeliverRequest,
  DeliverResponse,
  HireRequest,
  HireResponse,
  ModeRequest,
  PlayerState,
  RatType,
} from "@can-rat/shared";
import { PlayerStore } from "./store.js";

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
const store = new PlayerStore();
await store.load();

await app.register(cors, { origin: true, credentials: false });
await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });

const brandMultipliers: Record<BrandId, number> = {
  malt: 0.92,
  fizz: 1.16,
  nova: 1.54,
  orbit: 2.18,
};

const RAT_ARCHIVE_URL = "https://opengameart.org/sites/default/files/rat_godot.zip";
interface RatAssetCache {
  dae: string;
  png: Uint8Array;
}
let ratAssetCache: RatAssetCache | undefined;

function playerIdFrom(headers: Record<string, unknown>): string {
  const raw = headers["x-player-id"];
  if (typeof raw === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(raw)) return raw;
  return `guest_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function publicState(player: PlayerState): PlayerState {
  store.resolveProcessing(player);
  return structuredClone(player);
}

async function fetchRatAsset(): Promise<RatAssetCache> {
  if (ratAssetCache) return ratAssetCache;
  const response = await fetch(RAT_ARCHIVE_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`Rat asset archive unavailable (${response.status})`);
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const daeSource = archive["rat.dae"];
  const pngSource = archive["rat.png"];
  if (!daeSource || !pngSource) throw new Error("Rat asset archive is missing rat.dae or rat.png");
  ratAssetCache = { dae: strFromU8(daeSource), png: pngSource };
  return ratAssetCache;
}

app.get("/health", async () => ({ ok: true, now: Date.now() }));

app.get("/assets/rat.dae", async (_request: FastifyRequest, reply: FastifyReply) => {
  const asset = await fetchRatAsset();
  reply
    .type("model/vnd.collada+xml; charset=utf-8")
    .header("cache-control", "public, max-age=86400, stale-while-revalidate=604800")
    .header("x-asset-license", "CC0-1.0")
    .header("x-asset-source", "OpenGameArt rat-0 by br-n518");
  return asset.dae;
});

app.get("/assets/rat.png", async (_request: FastifyRequest, reply: FastifyReply) => {
  const asset = await fetchRatAsset();
  reply
    .type("image/png")
    .header("cache-control", "public, max-age=86400, stale-while-revalidate=604800")
    .header("x-asset-license", "CC0-1.0")
    .header("x-asset-source", "OpenGameArt rat-0 by br-n518");
  return Buffer.from(asset.png);
});

app.get("/api/session", async (request: FastifyRequest) => {
  const playerId = playerIdFrom(request.headers as Record<string, unknown>);
  const player = store.get(playerId);
  const before = player.processing.length;
  const state = publicState(player);
  if (before !== state.processing.length) await store.persist();
  return state;
});

app.post<{ Body: DeliverRequest }>(
  "/api/deliver",
  {
    schema: {
      body: Type.Object({
        brandId: Type.Union([
          Type.Literal("malt"), Type.Literal("fizz"), Type.Literal("nova"), Type.Literal("orbit"),
        ]),
        brandMultiplier: Type.Number({ minimum: 0.8, maximum: 2.4 }),
        stompMultiplier: Type.Number({ minimum: 0.6, maximum: 1.9 }),
        eventId: Type.String({ minLength: 8, maxLength: 80 }),
      }),
    },
  },
  async (request: FastifyRequest<{ Body: DeliverRequest }>, reply: FastifyReply): Promise<DeliverResponse> => {
    const playerId = playerIdFrom(request.headers as Record<string, unknown>);
    const player = store.get(playerId);
    store.resolveProcessing(player);
    if (store.isConsumed(playerId, request.body.eventId)) {
      reply.code(409);
      throw new Error("Duplicate delivery event.");
    }
    const expectedBrand = brandMultipliers[request.body.brandId];
    if (Math.abs(expectedBrand - request.body.brandMultiplier) > 0.001) {
      reply.code(400);
      throw new Error("Invalid brand multiplier.");
    }
    const stomp = Math.min(1.82, Math.max(0.66, request.body.stompMultiplier));
    const quality = Number((expectedBrand * stomp).toFixed(4));
    let revenue = 0;
    let queued = false;
    if (player.mode === "direct") {
      const brokerMultiplier = 1 + player.roster.broker * 0.12;
      revenue = Math.max(1, Math.round(12 * quality * brokerMultiplier));
      player.cash += revenue;
      player.lifetimeRevenue += revenue;
    } else {
      queued = true;
      player.processing.push({ id: randomUUID(), quality, readyAt: Date.now() + store.processingDuration(player) });
    }
    player.delivered += 1;
    player.updatedAt = Date.now();
    store.consume(playerId, request.body.eventId);
    await store.persist();
    return { state: publicState(player), acceptedQuality: quality, revenue, queued };
  },
);

app.post<{ Body: HireRequest }>(
  "/api/hire",
  {
    schema: {
      body: Type.Object({
        type: Type.Union([
          Type.Literal("runner"), Type.Literal("hauler"), Type.Literal("broker"), Type.Literal("engineer"),
        ]),
      }),
    },
  },
  async (request: FastifyRequest<{ Body: HireRequest }>, reply: FastifyReply): Promise<HireResponse> => {
    const playerId = playerIdFrom(request.headers as Record<string, unknown>);
    const player = store.get(playerId);
    store.resolveProcessing(player);
    const type = request.body.type as RatType;
    const cost = store.hireCost(player, type);
    if (player.cash < cost) {
      reply.code(400);
      throw new Error("Insufficient cash.");
    }
    player.cash -= cost;
    player.roster[type] += 1;
    player.updatedAt = Date.now();
    await store.persist();
    return { state: publicState(player), cost };
  },
);

app.post<{ Body: ModeRequest }>(
  "/api/mode",
  {
    schema: { body: Type.Object({ mode: Type.Union([Type.Literal("direct"), Type.Literal("process")]) }) },
  },
  async (request: FastifyRequest<{ Body: ModeRequest }>): Promise<PlayerState> => {
    const playerId = playerIdFrom(request.headers as Record<string, unknown>);
    const player = store.get(playerId);
    store.resolveProcessing(player);
    player.mode = request.body.mode as BusinessMode;
    player.updatedAt = Date.now();
    await store.persist();
    return publicState(player);
  },
);

app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) => {
  const statusCode = reply.statusCode >= 400 ? reply.statusCode : 500;
  reply.code(statusCode).send({ error: statusCode >= 500 ? "Internal server error." : error.message });
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
await app.listen({ port, host });
