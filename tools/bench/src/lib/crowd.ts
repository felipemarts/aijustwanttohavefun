/**
 * A crowd of simulated agents playing over HTTP through the SDK, at a fixed total action rate.
 *
 * Each agent keeps the view its last answers gave it (`/act` returns `you` and the room when it changed; `GET /me`
 * refreshes the bag every 15 actions or after an inventory action) and decides locally with the bench `Brain`. A
 * dispatcher hands out action slots at exactly `rate` per second to the agents that are ready, so the offered load
 * does not depend on how fast the server answers (an open-loop load: a slow server shows up as latency, not as a
 * lower rate). Reads (`/look`, `/me`) come on top of the action rate, as they would from real agents.
 */
import type { Content } from '@ajwf/content';
import { inventoryFromMe, viewFromApi, type InventoryView } from '@ajwf/bots';
import { ApiError, createClient, type Client, type Room, type You } from '@ajwf/sdk';
import { createRng, type Rng } from '@ajwf/shared';
import { Brain, Mix } from './brain';
import { Samples, summarize } from './stats';

const INVENTORY_ACTIONS = new Set(['equip', 'unequip', 'use', 'shop_buy', 'shop_sell', 'gather', 'take', 'drop', 'craft', 'give', 'trade_accept']);
const ME_EVERY = 15;

export type CrowdAgent = { name: string; key: string };

class Member {
  you: You | null = null;
  room: Room | null = null;
  inv: InventoryView | null = null;
  needLook = true;
  needMe = true;
  acts = 0;
  busy = false;
  readyAt = 0;

  constructor(
    readonly client: Client,
    readonly brain: Brain,
  ) {}
}

export class Crowd {
  readonly members: Member[] = [];
  private readonly byName = new Map<string, Member>();
  readonly mix = new Mix();
  /** Client-side latency of `/act` (ms): network and the client's own event loop included. */
  readonly clientActMs = new Samples(1 << 16);
  readonly http: Record<string, number> = {};
  readonly transport: Record<string, number> = {};
  reads = 0;
  measuring = false;
  private dispatched = 0;
  private missed = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly rng: Rng;

  constructor(
    private readonly content: Content,
    url: string,
    agents: CrowdAgent[],
    seed: number,
  ) {
    this.rng = createRng(seed);
    const onResponse = (info: { path: string; status: number | 'network'; ms: number }) => {
      if (!this.measuring) return;
      const k = String(info.status);
      this.http[k] = (this.http[k] ?? 0) + 1;
      if (info.path.startsWith('/act') && info.status === 200) this.clientActMs.push(info.ms);
    };
    const base = createClient({ baseUrl: url, retries: 0, timeoutMs: 30_000, onResponse });
    for (const a of agents) {
      const m = new Member(base.withApiKey(a.key), Brain.make(a.name, createRng(this.rng.int(0, 2 ** 31))));
      this.members.push(m);
      this.byName.set(a.name.toLowerCase(), m);
    }
  }

  private fail(err: unknown): void {
    const code = err instanceof ApiError ? err.code : 'EXCEPTION';
    if (this.measuring) this.transport[code] = (this.transport[code] ?? 0) + 1;
  }

  /** Reads whatever the agent's view is missing (not counted as actions). */
  private async refresh(m: Member): Promise<void> {
    m.busy = true;
    try {
      if (m.needLook || !m.you || !m.room) {
        const r = await m.client.look();
        this.reads++;
        if (r.ok) {
          if (r.you) m.you = r.you;
          if (r.room) m.room = r.room;
          m.needLook = false;
        }
      }
      if (m.needMe || !m.inv || m.acts >= ME_EVERY) {
        const me = await m.client.me();
        this.reads++;
        if (me.ok) {
          m.inv = inventoryFromMe(me);
          m.you = me.you;
          m.needMe = false;
          m.acts = 0;
        }
      }
    } catch (err) {
      this.fail(err);
      m.readyAt = Date.now() + 2000;
    } finally {
      m.busy = false;
    }
  }

  /** Every agent reads its state once, a few hundred at a time (the ramp before measuring). */
  async warm(concurrency = 200): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < this.members.length) await this.refresh(this.members[next++]!);
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  private async act(m: Member, action: string, params: Record<string, unknown>): Promise<void> {
    m.busy = true;
    try {
      const r = await m.client.actRaw(action, params);
      m.acts++;
      if (this.measuring) this.mix.add(action, r.ok ? null : r.error.code);
      if (r.ok) {
        m.you = r.you;
        if (r.room) m.room = r.room;
        if (INVENTORY_ACTIONS.has(action)) m.needMe = true;
        if (action === 'trade_offer' && typeof r.data?.trade === 'string') this.byName.get(String(params.to).toLowerCase())?.brain.offers.push(r.data.trade);
      } else {
        m.needLook = true;
        if (r.error.code === 'IN_COMBAT' || r.error.code === 'DEAD') m.needMe = true;
      }
      // Next turn in 2 to 8 s: more agents are ready than the rate needs, as with a live crowd.
      m.readyAt = Date.now() + this.rng.range(2000, 8000);
    } catch (err) {
      this.fail(err);
      m.needLook = true;
      m.readyAt = Date.now() + 2000;
    } finally {
      m.busy = false;
    }
  }

  /** One action slot: the first ready agent that wants to act gets it. */
  private dispatch(now: number): boolean {
    const n = this.members.length;
    for (let tries = 0; tries < 64; tries++) {
      const m = this.members[this.rng.int(0, n - 1)]!;
      if (m.busy || m.readyAt > now) continue;
      if (m.needLook || m.needMe || !m.inv || !m.you || !m.room || m.acts >= ME_EVERY) {
        void this.refresh(m);
        continue;
      }
      const step = m.brain.decide(this.content, viewFromApi(this.content, m.you, m.room, m.inv), now);
      if ('wait' in step) {
        m.readyAt = now + Math.min(step.wait, 60_000) * this.rng.range(0.8, 1.2);
        m.needLook = true;
        continue;
      }
      void this.act(m, step.action, step.params);
      return true;
    }
    return false;
  }

  /** Starts handing out `rate` action slots per second. */
  start(rate: number): void {
    const t0 = Date.now();
    this.dispatched = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      const due = Math.floor(((now - t0) * rate) / 1000);
      while (this.dispatched < due) {
        this.dispatched++;
        if (!this.dispatch(now)) this.missed++;
      }
    }, 5);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Waits for requests in flight to settle. */
  async drain(maxMs = 30_000): Promise<void> {
    const t0 = Date.now();
    while (this.members.some((m) => m.busy) && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 50));
  }

  report(seconds: number) {
    const transportErrors = Object.values(this.transport).reduce((a, b) => a + b, 0);
    const requests = Object.values(this.http).reduce((a, b) => a + b, 0);
    const non200 = Object.entries(this.http).filter(([k]) => k !== '200').reduce((a, [, v]) => a + v, 0);
    return {
      actions: this.mix.total,
      actionsPerSec: Math.round((this.mix.total / seconds) * 10) / 10,
      reads: this.reads,
      slotsWithoutReadyAgent: this.missed,
      mix: this.mix.shares(),
      refusalShare: Math.round((1 - this.mix.ok / Math.max(1, this.mix.total)) * 1000) / 1000,
      refusals: this.mix.refused,
      httpStatus: this.http,
      httpErrorRate: Math.round((non200 / Math.max(1, requests)) * 1e5) / 1e5,
      transportErrors: this.transport,
      transportErrorRate: Math.round((transportErrors / Math.max(1, requests)) * 1e5) / 1e5,
      clientActMs: summarize(this.clientActMs.view(), 2),
    };
  }
}

/** Registers `n` agents with the admin token (claimed bots), `concurrency` at a time. */
export async function registerCrowd(url: string, adminToken: string, n: number, seed: number, concurrency = 16): Promise<CrowdAgent[]> {
  const { fantasyName } = await import('@ajwf/bots');
  const { CLASSES, LANGUAGES } = await import('@ajwf/shared');
  const rng = createRng(seed);
  const client = createClient({ baseUrl: url, adminToken, retries: 0 });
  const out: CrowdAgent[] = [];
  const taken = new Set<string>();
  let started = 0;
  const worker = async () => {
    while (started < n) {
      started++;
      for (let attempt = 0; attempt < 20; attempt++) {
        let name = fantasyName(rng);
        if (attempt > 3 || taken.has(name.toLowerCase())) name = `${name.slice(0, 14)}${String.fromCharCode(97 + rng.int(0, 25))}${String.fromCharCode(97 + rng.int(0, 25))}`;
        taken.add(name.toLowerCase());
        let r: Awaited<ReturnType<typeof client.register>>;
        try {
          r = await client.register({ name, class: rng.pick(CLASSES), language: rng.pick(LANGUAGES), appearance: 'surprise_me', bot: true, claimed: true });
        } catch (err) {
          // A busy machine can time a registration out; the name may or may not be taken now, so try another.
          if (err instanceof ApiError && (err.code === 'TIMEOUT' || err.code === 'NETWORK')) continue;
          throw err;
        }
        if (r.ok) {
          out.push({ name: r.agent.name, key: r.api_key });
          break;
        }
        if (r.error.code !== 'NAME_TAKEN' && r.error.code !== 'NAME_INVALID') throw new Error(`registration refused: ${r.error.code}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
