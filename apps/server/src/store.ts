import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PlayerState, RatType } from "@can-rat/shared";

const DATA_PATH = resolve(process.cwd(), "data/players.json");

interface StoreFile {
  players: Record<string, PlayerState>;
  consumedEvents: Record<string, number>;
}

const blankStore = (): StoreFile => ({
  players: {},
  consumedEvents: {},
});

export class PlayerStore {
  private data: StoreFile = blankStore();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(DATA_PATH, "utf8");
      this.data = JSON.parse(raw) as StoreFile;
    } catch {
      this.data = blankStore();
    }
    this.loaded = true;
  }

  private createPlayer(playerId: string): PlayerState {
    return {
      playerId,
      cash: 120,
      lifetimeRevenue: 0,
      delivered: 0,
      mode: "direct",
      roster: {
        runner: 1,
        hauler: 0,
        broker: 0,
        engineer: 0,
      },
      processing: [],
      updatedAt: Date.now(),
    };
  }

  get(playerId: string): PlayerState {
    const current = this.data.players[playerId];
    if (current) return current;
    const created = this.createPlayer(playerId);
    this.data.players[playerId] = created;
    return created;
  }

  resolveProcessing(player: PlayerState): number {
    const now = Date.now();
    const ready = player.processing.filter((item) => item.readyAt <= now);
    if (ready.length === 0) return 0;

    const brokerMultiplier = 1 + player.roster.broker * 0.12;
    const processingMultiplier = 1.72;
    const revenue = ready.reduce(
      (sum, item) => sum + Math.max(1, Math.round(12 * item.quality * processingMultiplier * brokerMultiplier)),
      0,
    );

    player.processing = player.processing.filter((item) => item.readyAt > now);
    player.cash += revenue;
    player.lifetimeRevenue += revenue;
    player.updatedAt = now;
    return revenue;
  }

  processingDuration(player: PlayerState): number {
    return Math.max(1_200, 5_000 * Math.pow(0.82, player.roster.engineer));
  }

  hireCost(player: PlayerState, type: RatType): number {
    const count = player.roster[type];
    const table: Record<RatType, { base: number; growth: number }> = {
      runner: { base: 60, growth: 1.72 },
      hauler: { base: 145, growth: 1.84 },
      broker: { base: 220, growth: 1.96 },
      engineer: { base: 260, growth: 1.96 },
    };
    const config = table[type];
    return Math.round(config.base * Math.pow(config.growth, count));
  }

  isConsumed(playerId: string, eventId: string): boolean {
    return Boolean(this.data.consumedEvents[`${playerId}:${eventId}`]);
  }

  consume(playerId: string, eventId: string): void {
    this.data.consumedEvents[`${playerId}:${eventId}`] = Date.now();
    const cutoff = Date.now() - 1000 * 60 * 60 * 24;
    for (const [key, timestamp] of Object.entries(this.data.consumedEvents)) {
      if (timestamp < cutoff) delete this.data.consumedEvents[key];
    }
  }

  async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(DATA_PATH), { recursive: true });
      const temp = `${DATA_PATH}.tmp`;
      await writeFile(temp, JSON.stringify(this.data, null, 2), "utf8");
      await rename(temp, DATA_PATH);
    });
    await this.writeChain;
  }
}
