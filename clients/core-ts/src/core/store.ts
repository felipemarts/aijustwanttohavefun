/**
 * What the core keeps on the device, over the `Storage` port. Secrets are not here: agent keys, claim links and
 * the provider key live in the `KeyVault` (see `vaultNames`).
 */
import type { AwaySummary, ChatMessage, Directives, EngineChoice, LogEntry, Settings } from '../api.ts';
import type { Storage } from '../ports.ts';
import type { ConstraintMode } from '../engine/types.ts';

export const vaultNames = {
  agentKey: (id: string) => `agent.${id}.key`,
  claimUrl: (id: string) => `agent.${id}.claim`,
  engineKey: 'engine.key',
};

export type Snapshot = {
  level: number;
  xp: [number, number];
  hp: [number, number];
  mp: [number, number];
  ap: [number, number];
  gold: number;
  roomId: string;
  roomName: string;
  title: string | null;
  inCombat?: string;
  /** Epoch ms when it gets up, while fallen. */
  fallenUntil?: number;
  partyMembers?: string[];
  guild?: string;
};

/** An `/act` sent but not yet answered, kept so a restart can repeat it with the same `Idempotency-Key`. */
export type PendingAct = { idemKey: string; action: string; paramsJson: string; thought: string; note: string; at: number };

/** Counters per character, as the desktop core keeps them (turn quality and speed). Not in the contract. */
export type TurnStats = {
  sessions: number;
  turns: number;
  accepted: number;
  refused: number;
  firstValid: number;
  retried: number;
  fallbacks: number;
  unconstrained: number;
  inferMs: number;
  turnMs: number;
  tokens: number;
  compactions: number;
};

export function emptyStats(): TurnStats {
  return { sessions: 0, turns: 0, accepted: 0, refused: 0, firstValid: 0, retried: 0, fallbacks: 0, unconstrained: 0, inferMs: 0, turnMs: 0, tokens: 0, compactions: 0 };
}

export type CharacterRecord = {
  id: string;
  /** The game server that issued its key: the key is sent there and nowhere else. */
  server: string;
  name: string;
  class: 'warrior' | 'mage' | 'rogue' | 'cleric';
  language: string;
  /** The public bio given at creation (the game shows it). */
  bio: string;
  createdAt: number;
  directives: Directives;
  /** The owner wants it to play. */
  run: boolean;
  /** When the next session (or the next turn of a session) starts. */
  nextActionAt: number;
  /** Why it is waiting (decides the status shown). */
  waitReason?: 'session' | 'ap' | 'cooldown' | 'engine' | 'server' | 'key' | 'rate';
  problem?: string;
  /** Values for the summary, kept so the interface has them without a request. */
  snapshot: Snapshot | null;
  sprite: string | null;
  claimed: boolean;
  /** True while the claim link is still kept in the vault. */
  hasClaimUrl: boolean;
  cursor?: string;
  /** The merged observation (playkit README 6.2) and the last GET /me, as member-ordered JSON text. */
  obsJson?: string;
  meJson?: string;
  meAt?: number;
  /** The playkit memory (notes, recent, chat, noteWait, world, told), as JSON text. */
  memoryJson?: string;
  /** The owner's command and the turns it stays in the prompt. */
  command?: { text: string; turnsLeft: number };
  pendingAct?: PendingAct;
  /** What happened since the owner last looked. */
  away: AwaySummary;
  failures: number;
  stats: TurnStats;
};

export type EngineRecord = Omit<EngineChoice, 'apiKey'> & { hasApiKey?: boolean; mode?: ConstraintMode };

const K = {
  settings: 'settings',
  engine: 'engine',
  char: (id: string) => `char/${id}`,
  logPrefix: (id: string) => `log/${id}/`,
  chatPrefix: (id: string) => `chat/${id}/`,
};

export const LOG_KEEP = 3000;

export class Repo {
  private s: Storage;
  private logCounts = new Map<string, number>();

  constructor(storage: Storage) {
    this.s = storage;
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.s.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  settings(): Promise<Settings | null> {
    return this.getJson<Settings>(K.settings);
  }
  saveSettings(s: Settings): Promise<void> {
    return this.s.set(K.settings, JSON.stringify(s));
  }

  engine(): Promise<EngineRecord | null> {
    return this.getJson<EngineRecord>(K.engine);
  }
  saveEngine(e: EngineRecord): Promise<void> {
    return this.s.set(K.engine, JSON.stringify(e));
  }

  async characters(): Promise<CharacterRecord[]> {
    const rows = await this.s.list('char/');
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.value) as CharacterRecord];
      } catch {
        return [];
      }
    });
  }
  saveCharacter(c: CharacterRecord): Promise<void> {
    return this.s.set(K.char(c.id), JSON.stringify(c));
  }

  async appendLog(id: string, e: LogEntry): Promise<void> {
    await this.s.set(`${K.logPrefix(id)}${e.id}`, JSON.stringify(e));
    const n = (this.logCounts.get(id) ?? 0) + 1;
    this.logCounts.set(id, n);
    // Trim the oldest now and then rather than on every write.
    if (n % 200 === 0) {
      const all = await this.s.list(K.logPrefix(id), { reverse: true, limit: LOG_KEEP + 400 });
      for (const r of all.slice(LOG_KEEP)) await this.s.delete(r.key);
    }
  }

  /** Newest first, strictly older than `before` when given. */
  async log(id: string, before: string | undefined, limit: number): Promise<LogEntry[]> {
    const rows = await this.s.list(K.logPrefix(id), { reverse: true, limit, ...(before ? { before: `${K.logPrefix(id)}${before}` } : {}) });
    return rows.map((r) => JSON.parse(r.value) as LogEntry);
  }

  async appendChat(id: string, m: ChatMessage): Promise<void> {
    await this.s.set(`${K.chatPrefix(id)}${m.id}`, JSON.stringify(m));
  }

  /** Oldest first: the last `limit` messages. */
  async chats(id: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.s.list(K.chatPrefix(id), { reverse: true, limit });
    return rows.map((r) => JSON.parse(r.value) as ChatMessage).reverse();
  }

  async forget(id: string): Promise<void> {
    await this.s.delete(K.char(id));
    for (const prefix of [K.logPrefix(id), K.chatPrefix(id)]) {
      for (const r of await this.s.list(prefix)) await this.s.delete(r.key);
    }
    this.logCounts.delete(id);
  }
}

export function emptyAway(since: number): AwaySummary {
  return { since, actions: 0, levels: 0, xp: 0, gold: 0, kills: 0, deaths: 0, highlights: [] };
}
