/**
 * What the director's star is doing, from their recent spectator-visible events: the "now" line of the star card,
 * the strip of their last actions, and the headline of a big moment. Pure, so each case is tested without a renderer.
 * Only events a spectator already receives are read; nothing here guesses at private ones (whispers, party or guild
 * chat never reach the client).
 */
import { eventPoints, type SpectatorEvent } from '@ajwf/shared';
import type { HighlightIcon, HighlightTone } from './highlights';

/** One thing the star does, ready to render: `ui.director.now.<key>`, an icon, a tone, and agent text when any. */
export type Activity = {
  key: string;
  params: Record<string, string | number>;
  icon: HighlightIcon;
  tone: HighlightTone;
  /** Agent-written words (a say, a wish, a campaign speech): escape and show as a quote. */
  quote: { text: string; lang: string | null } | null;
  /** The other party on the map, for the link drawn from the star. */
  target: { kind: 'agent' | 'mon'; id: string } | null;
  ts: number;
};

export type ActivityContext = {
  /** Monster kinds that are bosses. */
  bosses: ReadonlySet<string>;
  /** The star's room now. */
  room: string;
  /** The star is fallen now (their position says so). */
  fallen: boolean;
};

export const ACTIVITY = {
  /** The "now" line reads events no older than this... */
  nowMs: 30_000,
  /** ...then the star is wandering (moved within this window) or idle. */
  wanderMs: 120_000,
  /** A say answered by another agent within this window is a conversation. */
  talkMs: 20_000,
  /** Actions in the strip under the line. */
  recent: 3,
  /** A moment of the star worth this many points (the server's scoring) gets a banner. */
  bannerPoints: 10,
};

const mon = (id: string) => `@mon:${id.split(/[#:]/)[0]}`;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function act(
  ev: SpectatorEvent,
  key: string,
  icon: HighlightIcon,
  tone: HighlightTone,
  params: Record<string, string | number> = {},
  extra: Partial<Pick<Activity, 'quote' | 'target'>> = {},
): Activity {
  return { key, params, icon, tone, quote: extra.quote ?? null, target: extra.target ?? null, ts: ev.ts };
}

function quoteOf(ev: SpectatorEvent): Activity['quote'] {
  return typeof ev.text === 'string' && ev.text.trim() ? { text: ev.text, lang: ev.lang ?? null } : null;
}

/** The activity one event means for the star (as actor or target); null when it says nothing about them. */
export function activityOf(ev: SpectatorEvent, star: string, ctx: ActivityContext): Activity | null {
  const mine = ev.actor === star;
  const aimed = ev.tk === 'agent' && ev.target === star && ev.actor !== star;
  if (!mine && !aimed) {
    // Joining a party the star leads names the star only as the leader.
    if (ev.type === 'party_join' && ev.p?.leader === star && ev.actor)
      return act(ev, 'party_form', 'heart', 'teal', { name: ev.actor }, { target: { kind: 'agent', id: ev.actor } });
    return null;
  }
  const other = mine ? (ev.tk === 'agent' ? (ev.target ?? '') : '') : (ev.actor ?? '');
  const withAgent = other ? { target: { kind: 'agent' as const, id: other } } : {};
  const monster = ev.tk === 'mon' && ev.target ? ev.target : '';
  const withMon = monster ? { target: { kind: 'mon' as const, id: monster.split(/[#:]/)[0]! } } : {};
  const p = ev.p ?? {};
  switch (ev.type) {
    case 'attack':
    case 'cast_hit':
      if (aimed) return act(ev, 'attacked', 'shield', 'danger', { name: other }, withAgent);
      if (ev.tk === 'agent' && other) return act(ev, 'pvp_attack', 'dagger', 'danger', { name: other }, withAgent);
      if (!monster) return null;
      return ctx.bosses.has(monster.split(/[#:]/)[0]!)
        ? act(ev, 'boss', 'skull', 'danger', { mon: mon(monster) }, withMon)
        : act(ev, 'fight', 'swords', 'plain', { mon: mon(monster) }, withMon);
    case 'kill':
      if (!monster) return null;
      return ctx.bosses.has(monster.split(/[#:]/)[0]!)
        ? act(ev, 'boss_kill', 'skull', 'gold', { mon: mon(monster) }, withMon)
        : act(ev, 'slay', 'swords', 'plain', { mon: mon(monster) }, withMon);
    case 'pvp_kill':
      return mine
        ? act(ev, 'pvp_kill', 'skull', 'danger', { name: other }, withAgent)
        : act(ev, 'pvp_killed', 'skull', 'danger', { name: other }, withAgent);
    case 'flee':
      return act(ev, 'flee', 'boot', 'danger', { mon: str(p.mon) || mon(str(ev.target)) });
    case 'fallen':
      return mine ? act(ev, 'fallen', 'skull', 'danger') : null;
    case 'revive':
      return mine
        ? act(ev, 'revive', 'cross', 'teal', { name: other }, withAgent)
        : act(ev, 'revived', 'cross', 'teal', { name: other }, withAgent);
    case 'heal':
      return mine
        ? act(ev, 'heal', 'cross', 'teal', { name: other }, withAgent)
        : act(ev, 'healed', 'cross', 'teal', { name: other }, withAgent);
    case 'steal':
      return mine
        ? act(ev, 'steal', 'coin', 'danger', { name: other }, withAgent)
        : act(ev, 'robbed', 'coin', 'danger', { name: other }, withAgent);
    case 'steal_failed':
      return mine
        ? act(ev, 'steal_failed', 'coin', 'danger', { name: other }, withAgent)
        : act(ev, 'attacked', 'shield', 'danger', { name: other }, withAgent);
    case 'betrayal':
      return mine
        ? act(ev, 'betray', 'dagger', 'danger', { name: other }, withAgent)
        : act(ev, 'betrayed', 'dagger', 'danger', { name: other }, withAgent);
    case 'treasury_looted':
      return mine ? act(ev, 'loot_treasury', 'coin', 'danger', { guild: str(p.guild) }) : null;
    case 'guild_coup':
      return mine ? act(ev, 'coup', 'dagger', 'danger', { guild: str(p.guild) }) : null;
    case 'mayor_embezzle':
      return mine ? act(ev, 'embezzle', 'coin', 'danger', { gold: p.gold ?? 0 }) : null;
    case 'wish':
      return mine ? act(ev, 'wish', 'drop', 'gold', {}, { quote: quoteOf(ev) }) : null;
    case 'fountain_jackpot':
      return mine ? act(ev, 'jackpot', 'coin', 'gold') : null;
    case 'say':
      return mine ? act(ev, 'say', 'bubble', 'teal', {}, { quote: quoteOf(ev) }) : null;
    case 'emote':
      return mine
        ? other
          ? act(ev, 'emote_at', 'heart', 'teal', { name: other }, withAgent)
          : act(ev, 'emote', 'heart', 'teal')
        : null;
    case 'trade':
      return act(ev, 'trade', 'scales', 'teal', { name: other }, withAgent);
    case 'market_trade':
      return mine
        ? act(ev, 'buy', 'coin', 'teal', { item: str(p.item), name: other }, withAgent)
        : act(ev, 'sell', 'coin', 'teal', { item: str(p.item), name: other }, withAgent);
    case 'market_order':
      return mine ? act(ev, 'market_order', 'coin', 'plain', { item: str(p.item) }) : null;
    case 'craft':
      return mine ? act(ev, 'craft', 'hammer', 'plain', { item: str(p.item) }) : null;
    case 'gather':
      return mine ? act(ev, 'gather', 'pick', 'plain', { item: str(p.item) }) : null;
    case 'move':
      return mine ? act(ev, 'move', 'boot', 'plain', { room: `@room:${ev.room ?? ctx.room}` }) : null;
    case 'party_join':
      return mine ? act(ev, 'party_join', 'heart', 'teal', { name: str(p.leader) }) : null;
    case 'duel':
      return mine
        ? act(ev, 'duel_win', 'swords', 'gold', { name: other }, withAgent)
        : act(ev, 'duel_lose', 'swords', 'danger', { name: other }, withAgent);
    case 'duel_invite':
      return mine ? act(ev, 'duel_invite', 'swords', 'plain', { name: other }, withAgent) : null;
    case 'vote':
      return mine ? act(ev, 'vote', 'scroll', 'plain') : null;
    case 'run_for_mayor':
      return mine ? act(ev, 'run_for_mayor', 'crown', 'gold', {}, { quote: quoteOf(ev) }) : null;
    case 'project_contribution':
      return mine ? act(ev, 'project', 'hammer', 'teal', { proj: str(p.proj) }) : null;
    case 'level_up':
      return mine ? act(ev, 'level_up', 'up', 'gold', { level: p.level ?? '' }) : null;
    case 'achievement':
    case 'world_first':
      if (!mine) return null;
      return ev.type === 'world_first' || ev.k === 'ev.world_first'
        ? act(ev, 'world_first', 'star', 'gold', { ach: str(p.ach) })
        : act(ev, 'achievement', 'star', 'gold', { ach: str(p.ach) });
    case 'rare_drop':
      return mine ? act(ev, 'rare_drop', 'gem', 'gold', { item: str(p.item) }) : null;
    case 'arrival':
      return mine ? act(ev, 'arrival', 'star', 'teal') : null;
    case 'respawn':
      return mine ? act(ev, 'respawn', 'cross', 'plain') : null;
    default:
      return null;
  }
}

const same = (a: Activity, b: Activity) => a.key === b.key && JSON.stringify(a.params) === JSON.stringify(b.params);

/**
 * The star's "now" line and the strip of their previous actions, from events around them (their own and their
 * room's, oldest first). The newest event that says something about the star wins; a say answered by someone else
 * in the room within 20 s becomes "talking with <name>". Without recent events: wandering (moved lately) or idle.
 */
export function starNow(
  star: string,
  events: readonly SpectatorEvent[],
  nowTs: number,
  ctx: ActivityContext,
): { now: Activity; recent: Activity[] } {
  const acts: Activity[] = [];
  let lastMove = -Infinity;
  for (const ev of events) {
    if (nowTs - ev.ts > ACTIVITY.wanderMs || ev.ts > nowTs) continue;
    const a = activityOf(ev, star, ctx);
    if (!a) continue;
    if (ev.type === 'move') lastMove = ev.ts;
    if (a.key === 'say') {
      // Someone else spoke in the same room close in time: a conversation.
      const partner = [...events]
        .reverse()
        .find((o) => o.type === 'say' && o.actor && o.actor !== star && o.room === ev.room && Math.abs(o.ts - ev.ts) <= ACTIVITY.talkMs && o.ts <= nowTs);
      if (partner?.actor) {
        a.key = 'talk_with';
        a.params = { name: partner.actor };
        a.target = { kind: 'agent', id: partner.actor };
      }
    }
    acts.push(a);
  }
  const room = `@room:${ctx.room}`;
  const quiet: Activity = {
    key: nowTs - lastMove <= ACTIVITY.wanderMs ? 'wandering' : 'idle',
    params: { room },
    icon: nowTs - lastMove <= ACTIVITY.wanderMs ? 'boot' : 'moon',
    tone: 'plain',
    quote: null,
    target: null,
    ts: nowTs,
  };
  const latest = acts.length ? acts[acts.length - 1]! : null;
  let now: Activity;
  if (ctx.fallen) now = latest?.key === 'fallen' ? latest : { ...quiet, key: 'fallen', params: {}, icon: 'skull', tone: 'danger' };
  else now = latest && nowTs - latest.ts <= ACTIVITY.nowMs ? latest : quiet;
  // The strip: earlier actions, newest first, without repeats of the line or of each other.
  const recent: Activity[] = [];
  for (let i = acts.length - 1; i >= 0 && recent.length < ACTIVITY.recent; i--) {
    const a = acts[i]!;
    if (a === now || same(a, now) || recent.some((r) => same(r, a))) continue;
    recent.push(a);
  }
  return { now, recent };
}

/** Headline keys (`ui.director.banner.<key>`) of big moments, by event type. */
const BANNER: Record<string, string> = {
  fallen: 'fallen',
  pvp_kill: 'pvp_kill',
  betrayal: 'betrayal',
  world_first: 'world_first',
  fountain_jackpot: 'jackpot',
  steal: 'steal',
  treasury_looted: 'treasury',
  attack: 'pvp_attack',
  rare_drop: 'rare_drop',
  revive: 'revive',
  duel: 'duel',
  guild_coup: 'coup',
  mayor_embezzle: 'embezzle',
};

/**
 * A big moment of the star: an event worth `ACTIVITY.bannerPoints` or more to them (the actor gets the points, a
 * target agent half, as the server scores it). Returns the headline (`ui.director.banner.<key>`) and the points, or
 * null.
 */
export function bigMoment(
  ev: SpectatorEvent,
  star: string,
  ctx: { bosses: ReadonlySet<string>; bot: boolean },
): { key: string; params: Record<string, string | number>; points: number; target: Activity['target'] } | null {
  const mine = ev.actor === star;
  const aimed = ev.tk === 'agent' && ev.target === star && ev.actor !== star;
  if (!mine && !aimed) return null;
  const kind = ev.tk === 'mon' && ev.target ? ev.target.split(/[#:]/)[0]! : '';
  const boss = ev.type === 'kill' && !!kind && ctx.bosses.has(kind);
  const worldFirst = ev.type === 'world_first' || (ev.type === 'achievement' && ev.k === 'ev.world_first');
  const base = eventPoints({
    type: ev.type === 'world_first' ? 'achievement' : ev.type,
    drama: ev.drama,
    boss,
    worldFirst,
    vsAgent: ev.tk === 'agent',
    bot: ctx.bot,
  });
  const points = mine ? base : base / 2;
  if (points < ACTIVITY.bannerPoints) return null;
  const key = boss ? 'boss_kill' : worldFirst ? 'world_first' : ev.type === 'attack' && ev.tk !== 'agent' ? null : (BANNER[ev.type] ?? 'generic');
  if (!key) return { key: 'generic', params: { actor: star }, points, target: null };
  const p = ev.p ?? {};
  const params: Record<string, string | number> = {
    actor: ev.actor ?? star,
    name: ev.tk === 'agent' ? (ev.target ?? '') : '',
    mon: kind ? `@mon:${kind}` : '',
    item: str(p.item),
    guild: str(p.guild),
    gold: p.gold ?? '',
  };
  if (key === 'generic') params.actor = star;
  const target = ev.tk === 'agent' && ev.target ? { kind: 'agent' as const, id: mine ? ev.target : (ev.actor ?? '') } : kind ? { kind: 'mon' as const, id: kind } : null;
  return { key, params, points, target };
}
