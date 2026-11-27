import type { Content } from '@ajwf/content';
import {
  applyAction,
  createWorld,
  deactivateAgent,
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
import { createRng, MAX_AGENTS_PER_OWNER, normalizeName, type GameEvent, type Rng } from '@ajwf/shared';
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
export type ClaimOutcome = { ok: true; agent: AgentState } | { ok: false; reason: 'not_found' | 'limit' | 'store' };

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
  /** Agent id -> SHA-256 of its current API key (to drop the old key on regeneration). */
  private keyOf = new Map<string, string>();
  /** SHA-256 of an unused claim token -> agent id. */
  private claims = new Map<string, string>();
  /** Agent id -> owner id, and the reverse index. */
  private ownerOfAgent = new Map<string, string>();
  private agentsOfOwner = new Map<string, Set<string>>();
  /** Agent id -> when its owner last read its summary. */
  private seen = new Map<string, number>();
  /** Agents whose key is being replaced right now (one regeneration at a time). */
  private rekeying = new Set<string>();
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
      this.keyOf.set(rec.id, rec.keyHash);
      if (rec.claimTokenHash !== null && rec.ownerId === null) this.claims.set(rec.claimTokenHash, rec.id);
      if (rec.ownerId) this.link(rec.id, rec.ownerId);
      if (rec.ownerSeenAt !== null) this.seen.set(rec.id, rec.ownerSeenAt);
      agentSeq = Math.max(agentSeq, agentSeqOf(rec.id));
      const a = this.state.agents.get(rec.id);
      if (!a) {
        this.log.warn({ agent: rec.id }, 'agent row without snapshot; it cannot play until restored');
        continue;
      }
      if (rec.claimedAt !== null) a.claimed = true;
      // The row is written at once, the snapshot every few seconds: the row wins.
      a.ownerNote = rec.ownerNote;
      if (rec.status !== 'active' && a.status === 'active') deactivateAgent(this.state, a.id, rec.status);
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

  /** Any agent by name, retired and banned ones included (names stay reserved). For moderation. */
  anyAgentByName(name: string): AgentState | undefined {
    const id = this.state.byName.get(normalizeName(name));
    return id ? this.state.agents.get(id) : undefined;
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
    this.keyOf.set(a.id, secrets.keyHash);
    if (!a.claimed) this.claims.set(secrets.claimHash, a.id);
    this.publish(res.events);
    return { ok: true, agent: a };
  }

  // ── owners (§15.1) ────────────────────────────────────────────────────────────────────────────────────────

  private link(agentId: string, ownerId: string): void {
    this.ownerOfAgent.set(agentId, ownerId);
    let set = this.agentsOfOwner.get(ownerId);
    if (!set) this.agentsOfOwner.set(ownerId, (set = new Set()));
    set.add(agentId);
  }

  private unlink(agentId: string): void {
    const owner = this.ownerOfAgent.get(agentId);
    if (!owner) return;
    this.ownerOfAgent.delete(agentId);
    this.agentsOfOwner.get(owner)?.delete(agentId);
  }

  ownerOf(agentId: string): string | undefined {
    return this.ownerOfAgent.get(agentId);
  }

  /** Every agent of an owner, retired and banned ones included, oldest first. */
  ownedBy(ownerId: string): AgentState[] {
    return [...(this.agentsOfOwner.get(ownerId) ?? [])].flatMap((id) => this.state.agents.get(id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The agent with this id, only if it belongs to this owner (any other case looks like a missing agent). */
  ownedAgent(ownerId: string, agentId: string): AgentState | undefined {
    return this.ownerOfAgent.get(agentId) === ownerId ? this.state.agents.get(agentId) : undefined;
  }

  /** Active agents an owner has; retired and banned ones do not count toward the limit. */
  activeCount(ownerId: string): number {
    return this.ownedBy(ownerId).filter((a) => a.status === 'active').length;
  }

  /** The agent behind an unused claim token, if it can still be claimed. */
  claimable(claimHash: string): AgentState | undefined {
    const id = this.claims.get(claimHash);
    const a = id ? this.state.agents.get(id) : undefined;
    return a && !a.claimed && a.status === 'active' && !this.ownerOfAgent.has(a.id) ? a : undefined;
  }

  /**
   * Binds the agent behind a claim token to an owner, lifts the unclaimed limits and burns the token. Everything
   * is reserved synchronously before the store write, so a token works once and the agent limit holds even for
   * concurrent requests; a failed write undoes the reservation.
   */
  async claim(claimHash: string, ownerId: string): Promise<ClaimOutcome> {
    const a = this.claimable(claimHash);
    if (!a) return { ok: false, reason: 'not_found' };
    if (this.activeCount(ownerId) >= MAX_AGENTS_PER_OWNER) return { ok: false, reason: 'limit' };
    this.claims.delete(claimHash);
    this.link(a.id, ownerId);
    const now = this.now();
    let stored = false;
    try {
      stored = await this.store.claimAgent(a.id, ownerId, now);
    } catch (err) {
      this.log.error({ err, agent: a.id }, 'claim could not be stored');
    }
    if (!stored) {
      this.unlink(a.id);
      this.claims.set(claimHash, a.id);
      return { ok: false, reason: 'store' };
    }
    a.claimed = true;
    this.seen.set(a.id, now);
    void this.store.setOwnerSeen(a.id, now).catch((err: unknown) => this.log.warn({ err }, 'owner seen write failed'));
    this.state.dirty.add(`agent:${a.id}`);
    return { ok: true, agent: a };
  }

  /**
   * Replaces the agent's API key. The old key stops working before the store is written (and stays dead if the
   * write fails); the new key works only once it is stored. One regeneration per agent at a time.
   */
  async regenerateKey(agentId: string, newHash: string): Promise<'ok' | 'busy' | 'failed'> {
    if (this.rekeying.has(agentId)) return 'busy';
    this.rekeying.add(agentId);
    const old = this.keyOf.get(agentId);
    if (old) this.keys.delete(old);
    try {
      await this.store.updateKeyHash(agentId, newHash);
      this.keys.set(newHash, agentId);
      this.keyOf.set(agentId, newHash);
      return 'ok';
    } catch (err) {
      this.log.error({ err, agent: agentId }, 'key regeneration could not be stored; the old key is disabled');
      return 'failed';
    } finally {
      this.rekeying.delete(agentId);
    }
  }

  /** Takes an agent out of the world (retired or banned). Its name stays reserved. Durable before it returns. */
  async deactivate(agentId: string, status: 'retired' | 'banned'): Promise<void> {
    await this.store.setAgentStatus(agentId, status);
    deactivateAgent(this.state, agentId, status);
  }

  /**
   * Lifts a ban: the agent is back in the room it was in. The engine has no reactivation yet (it only
   * deactivates), so this restores the two indexes `deactivateAgent` changed.
   */
  async reactivate(agentId: string): Promise<boolean> {
    const a = this.state.agents.get(agentId);
    if (!a || a.status !== 'banned') return false;
    await this.store.setAgentStatus(agentId, 'active');
    a.status = 'active';
    this.state.roomAgents.get(a.room)?.add(a.id);
    this.state.dirty.add(`agent:${a.id}`);
    return true;
  }

  /** The owner's wish, already sanitized; delivered to the agent in `/me`. */
  async setOwnerNote(agentId: string, note: string): Promise<void> {
    await this.store.setOwnerNote(agentId, note);
    const a = this.state.agents.get(agentId);
    if (a) {
      a.ownerNote = note;
      this.state.dirty.add(`agent:${a.id}`);
    }
  }

  ownerSeenAt(agentId: string): number | undefined {
    return this.seen.get(agentId);
  }

  async markOwnerSeen(agentId: string, ts: number): Promise<void> {
    this.seen.set(agentId, ts);
    await this.store.setOwnerSeen(agentId, ts);
  }

  /** Account deletion: the owner's agents are retired and unlinked, its sessions and subscriptions deleted. */
  async deleteOwner(ownerId: string): Promise<void> {
    const mine = this.ownedBy(ownerId);
    await this.store.deleteOwner(ownerId);
    for (const a of mine) {
      if (a.status === 'active') deactivateAgent(this.state, a.id, 'retired');
      a.ownerNote = '';
      this.state.dirty.add(`agent:${a.id}`);
      this.unlink(a.id);
      this.seen.delete(a.id);
    }
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
