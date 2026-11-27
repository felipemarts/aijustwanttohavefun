import { dayPhase, villageView, worldBossInfo, type VillageView, type WorldState } from '@ajwf/engine';
import { truncateCodePoints } from '@ajwf/shared';
import { npcPrices, recentPrices } from '../chronicle/prices';

/** Read models of the village for the agent API (compact) and the public pages (complete). No agent ids leave. */

const COMPACT_CANDIDATES = 5;
const COMPACT_PLATFORM = 160;
const COMPACT_PRICES = 8;
const PUBLIC_PRICES = 40;
const HOUR = 3_600_000;

const pct = (rate: number) => Math.round(rate * 1000) / 10;
const hoursUntil = (t: number, now: number) => Math.max(0, Math.round(((t - now) / HOUR) * 10) / 10);

function priceRows(s: WorldState, now: number, limit: number) {
  const npc = npcPrices(s.content);
  return recentPrices(s.market.history, now)
    .slice(0, limit)
    .map((r) => {
      const n = npc.get(r.item);
      return { item: r.item, avg: r.avg, n: r.n, ...(n?.buys !== undefined ? { npc_buys: n.buys } : {}), ...(n?.sells !== undefined ? { npc_sells: n.sells } : {}) };
    });
}

function boss(s: WorldState, now: number) {
  const b = worldBossInfo(s);
  if (!b) return undefined;
  return b.up ? { id: b.monster, room: b.room, up: true, leaves_in_min: Math.max(0, Math.round(((b.leaves ?? now) - now) / 60_000)) } : { id: b.monster, room: b.room, in_min: Math.max(0, Math.round((b.at - now) / 60_000)) };
}

/**
 * `GET /api/v1/village`: what an agent needs to take part in village life, within about 500 tokens. Projects with
 * what is still missing, the race for mayor (platforms as untrusted text; the turnout but no totals while voting),
 * treasury, tax, reference prices, the next world boss and the gazette headline.
 */
export function compactVillage(s: WorldState, now: number, o: { population: number; online: number; headline?: string }) {
  const v = villageView(s, now);
  const open: Record<string, unknown>[] = [];
  const locked: string[] = [];
  const done: string[] = [];
  for (const p of v.projects) {
    if (p.status === 'done') done.push(p.id);
    else if (p.status === 'locked') locked.push(p.id);
    else open.push({ id: p.id, site: p.site, pct: Math.floor(p.progress * 100), need: { ...(p.missing!.gold > 0 ? { gold: p.missing!.gold } : {}), ...p.missing!.items } });
  }
  const e = v.election;
  // In order of candidacy: the ballot is secret and the totals stay sealed until the election closes.
  const cands = e.candidates.filter((c) => c.active);
  const prices: Record<string, unknown> = {};
  for (const r of priceRows(s, now, COMPACT_PRICES)) {
    const { item, n: _n, ...rest } = r;
    prices[item] = rest;
  }
  const wb = boss(s, now);
  return {
    ok: true as const,
    time: dayPhase(now),
    population: o.population,
    online: o.online,
    mayor: v.mayor?.name ?? null,
    treasury: v.treasury,
    tax_pct: pct(v.taxRate),
    priority: v.priority,
    projects: { open, ...(locked.length ? { locked } : {}), ...(done.length ? { done } : {}) },
    election: {
      n: e.n,
      phase: e.phase,
      ...(e.phase === 'candidacy' ? { voting_in_h: hoursUntil(e.voteAt, now) } : { closes_in_h: hoursUntil(e.end, now), voters: e.voters }),
      candidates: cands.slice(0, COMPACT_CANDIDATES).map((c) => ({ name: c.name, platform: { untrusted_text: truncateCodePoints(c.platform, COMPACT_PLATFORM) } })),
      ...(cands.length > COMPACT_CANDIDATES ? { more: cands.length - COMPACT_CANDIDATES } : {}),
    },
    ...(Object.keys(prices).length ? { prices } : {}),
    ...(wb ? { world_boss: wb } : {}),
    ...(o.headline ? { gazette: o.headline } : {}),
  };
}

/** `GET /api/public/village`: the full read model for the village page. Agent-written fields are marked. */
export function publicVillage(s: WorldState, now: number, o: { population: number; online: number }) {
  const v: VillageView = villageView(s, now);
  const halls: Record<string, { guild: string; colors: [string, string]; at: number }> = {};
  const buildings: Record<string, string> = {};
  for (const [plot, b] of Object.entries(v.buildings)) {
    if (b.kind === 'project') buildings[plot] = b.project;
    else halls[plot] = { guild: b.name, colors: b.colors, at: b.at };
  }
  return {
    now,
    population: o.population,
    online: o.online,
    treasury: v.treasury,
    taxRate: v.taxRate,
    priority: v.priority,
    mayor: v.mayor,
    election: {
      ...v.election,
      /** `platform` is agent-written text in `lang`: escape before display. No totals: they appear once the election closes. */
      candidates: v.election.candidates.map((c) => ({ name: c.name, at: c.at, platform: c.platform, lang: c.lang, active: c.active })),
    },
    lastElection: v.lastElection ? { n: v.lastElection.n, start: v.lastElection.start, end: v.lastElection.end, winner: v.lastElection.winner, votes: v.lastElection.votes.map((x) => ({ name: x.name, votes: x.votes })) } : null,
    projects: v.projects.map((p) => ({
      id: p.id,
      site: p.site,
      building: p.building,
      status: p.status,
      progress: p.progress,
      requires: p.requires,
      ...(p.missing ? { missing: p.missing } : {}),
      ...(p.doneAt !== undefined ? { doneAt: p.doneAt } : {}),
      // Plaque lines without agent ids; a null name is the village itself.
      ...(p.plaque ? { plaque: p.plaque.map((l) => ({ name: l.name, value: l.value })) } : {}),
    })),
    buildings,
    halls,
    honoree: v.honoree,
    worldBoss: worldBossInfo(s),
    prices: priceRows(s, now, PUBLIC_PRICES),
  };
}
