import type { Content } from '@ajwf/content';
import {
  applyAction,
  createWorld,
  observe,
  registerAgent,
  restoreWorld,
  tick,
  unregisterAgent,
  type ActionError,
  type ActionResult,
  type AgentState,
  type Observation,
  type RegisterInput,
  type WorldState,
} from '@ajwf/engine';
import { createRng, normalizeName, type GameEvent, type Rng } from '@ajwf/shared';
import type { Logger } from 'pino';
import type { LoadedState, Store } from './store/types';

export type Clock = () => number;

/** Anything that reacts to what happened in the world: persistence now; broadcast, highlights and achievements later. */
export interface EventConsumer {
  readonly name: string;
  consume(events: readonly GameEvent[]): void;
}

export type GameOptions = { store: Store; content: Content; now: Clock; seed: number; log: Logger };

export type RegisterSecrets = { keyHash: string; claimHash: string };
export type RegisterOutcome = { ok: true; agent: AgentState } | { ok: false; error: ActionError };

const TICK_MS = 1000;
const DAY_MS = 24 * 3_600_000;
/** The day timer fires this long after UTC midnight, so the new day has surely begun on every clock reading. */
const DAY_SLACK_MS = 50;

/** Ids are `a` + base-36 sequence (engine `registerAgent`). */
function agentSeqOf(id: string): number {
  return /^a[0-9a-z]+$/.test(id) ? parseInt(id.slice(1), 36) : 0;
}

/**
 * Owns the authoritative world. Node's single thread is the command queue: every engine call is synchronous, so
 * commands run one at a time and nothing may `await` between reading and writing game state.
 */
export class Game {
  readonly content: Content;
  readonly now: Clock;
  readonly rng: Rng;
  readonly store: Store;
  private readonly log: Logger;
  private consumers: EventConsumer[] = [];
  /** SHA-256 of the API key -> agent id. */
  private keys = new Map<string, string>();
  /** SHA-256 of the claim token -> agent id. */
  private claims = new Map<string, string>();
  /** Registrations whose row is not stored yet: their snapshots must wait for the row (foreign key). */
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private dayTimer: NodeJS.Timeout | null = null;
  private dayListeners: ((now: number) => void)[] = [];

  private constructor(
    readonly state: WorldState,
    o: GameOptions,
  ) {
    this.content = o.content;
    this.now = o.now;
    this.rng = createRng(o.seed);
    this.store = o.store;
    this.log = o.log;
  }

  /** Loads the saved world (or creates a fresh one) and the agents' credentials. */
  static async boot(o: GameOptions): Promise<Game> {
    const loaded = await o.store.load();
    const now = o.now();
    const state = loaded.snapshot ? restoreWorld(o.content, loaded.snapshot, now) : createWorld(o.content, now);
    const game = new Game(state, o);
    game.adopt(loaded);
    return game;
  }

  private adopt(loaded: LoadedState): void {
    const meta = this.state.meta;
    let agentSeq = meta.agentSeq;
    for (const rec of loaded.identities) {
      this.keys.set(rec.keyHash, rec.id);
      this.claims.set(rec.claimTokenHash, rec.id);
      agentSeq = Math.max(agentSeq, agentSeqOf(rec.id));
      const a = this.state.agents.get(rec.id);
      if (!a) this.log.warn({ agent: rec.id }, 'agent row without snapshot; it cannot play until restored');
      else if (rec.claimedAt !== null) a.claimed = true;
    }
    // The meta snapshot may be up to 5 s older than the rows and events already stored: never reuse an id.
    if (agentSeq > meta.agentSeq || loaded.maxEventId > meta.eventSeq) {
      meta.agentSeq = agentSeq;
      meta.eventSeq = Math.max(meta.eventSeq, loaded.maxEventId);
      this.state.dirty.add('meta');
    }
  }

  /** Called at every real-day rollover (UTC midnight) while the game runs: the gazette closes the day. */
  onDayRollover(fn: (now: number) => void): void {
    this.dayListeners.push(fn);
  }

  private scheduleDay(): void {
    const now = this.now();
    const wait = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS + DAY_SLACK_MS - now;
    this.dayTimer = setTimeout(() => {
      const t = this.now();
      for (const fn of this.dayListeners) {
        try {
          fn(t);
        } catch (err) {
          this.log.error({ err }, 'day rollover failed');
        }
      }
      this.scheduleDay();
    }, wait);
    this.dayTimer.unref?.();
  }

  subscribe(c: EventConsumer): void {
    this.consumers.push(c);
  }

  /** The single exit of every batch of events. A failing consumer is logged and never breaks the others. */
  publish(events: readonly GameEvent[]): void {
    if (!events.length) return;
    for (const c of this.consumers) {
      try {
        c.consume(events);
      } catch (err) {
        this.log.error({ err, consumer: c.name }, 'event consumer failed');
      }
    }
  }

  private ctx() {
    return { now: this.now(), rng: this.rng };
  }

  agentByKeyHash(hash: string): AgentState | undefined {
    const id = this.keys.get(hash);
    const a = id ? this.state.agents.get(id) : undefined;
    return a?.status === 'active' ? a : undefined;
  }

  agentByName(name: string): AgentState | undefined {
    const id = this.state.byName.get(normalizeName(name));
    const a = id ? this.state.agents.get(id) : undefined;
    return a?.status === 'active' ? a : undefined;
  }

  isPending(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  act(agentId: string, action: string, params: unknown): ActionResult {
    const out = applyAction(this.state, { agentId, action, params }, this.ctx());
    this.publish(out.events);
    return out.result;
  }

  observe(agentId: string): Observation {
    return observe(this.state, agentId, this.ctx());
  }

  tick(): void {
    this.publish(tick(this.state, this.ctx()));
  }

  /**
   * Creates the agent in memory, then stores its row and first snapshot. Only a stored agent gets its key: when
   * the write fails the registration is undone.
   */
  async register(input: RegisterInput, secrets: RegisterSecrets): Promise<RegisterOutcome> {
    const now = this.now();
    const res = registerAgent(this.state, input, { now, rng: this.rng });
    if (!res.ok) return res;
    const a = res.agent;
    this.pending.add(a.id);
    const snapshotJson = JSON.stringify(a);
    try {
      await this.store.insertAgent(
        {
          id: a.id,
          name: a.name,
          nameNorm: a.norm,
          nameSkeleton: a.skeleton,
          cls: a.cls,
          language: a.lang,
          bio: a.bio,
          appearance: a.appearance,
          appearanceHash: a.lookHash,
          keyHash: secrets.keyHash,
          claimTokenHash: secrets.claimHash,
          isBot: a.bot,
          claimedAt: a.claimed ? now : null,
        },
        snapshotJson,
        now,
      );
    } catch (err) {
      this.log.error({ err, agent: a.id }, 'could not store a new agent; registration undone');
      unregisterAgent(this.state, a.id);
      return { ok: false, error: { code: 'INTERNAL', msg: { k: 'api.err.store_failed' }, hint: { k: 'api.hint.store_failed' } } };
    } finally {
      this.pending.delete(a.id);
    }
    this.keys.set(secrets.keyHash, a.id);
    this.claims.set(secrets.claimHash, a.id);
    this.publish(res.events);
    return { ok: true, agent: a };
  }

  /** Marks the agent behind a claim token as owned. Durable before it takes effect. */
  async claim(claimHash: string): Promise<AgentState | null> {
    const id = this.claims.get(claimHash);
    const a = id ? this.state.agents.get(id) : undefined;
    if (!a) return null;
    if (!a.claimed) {
      await this.store.markClaimed(a.id, this.now());
      a.claimed = true;
      this.state.dirty.add(`agent:${a.id}`);
    }
    return a;
  }

  start(): void {
    this.timer ??= setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.log.error({ err }, 'tick failed');
      }
    }, TICK_MS);
    if (!this.dayTimer) this.scheduleDay();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.dayTimer) clearTimeout(this.dayTimer);
    this.dayTimer = null;
  }
}
