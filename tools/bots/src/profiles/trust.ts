/**
 * Trust and betrayal (PLANEJAMENTO §7): what honest bots do about cheats, and the traitor's opportunities.
 *
 * Pay-first deals are the meeting point of both. A seller `say`s "DEAL: selling <item> for <gold> gold. Pay first
 * with give." in its room; a buyer who hears it, trusts the seller and wants the item `give`s the gold and waits for
 * the item. An honest trader delivers with `give`; a traitor keeps the gold. A buyer whose item never came reports
 * the scam with the event id `give` answered, and stops trusting the seller.
 *
 * Everything is read from the game: the inbox (deals said in the room, gifts received, thefts witnessed, attacks,
 * betrayals and kills), the room (who is Wanted) and the answers to the bot's own actions.
 */
import { BALANCE } from '@ajwf/engine';
import type { BotStep } from '../solo';
import { cmd, have, hpShare, inVillage, partyHereSeen, seen } from './common';
import type { AgentView, DecideCtx } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;

export const TRUST_TUNING = {
  /** A buyer waits this long for the item before reporting a scam. */
  deliveryWaitMs: 45 * MIN,
  /** Highest price a buyer pays, as a multiple of the item's base value. */
  dealMaxValue: 2,
  /** Gold a buyer keeps after paying. */
  buyerReserve: 60,
  /** Bounty put on an agent who attacked us or our party, and how often per target. */
  bountyGold: 30,
  bountyEveryMs: 24 * HOUR,
  /** Honest bots only hunt Wanted agents with HP above this share. */
  huntAbove: 0.6,
  /** A seller repeats its deal this often. */
  dealEveryMs: 2 * HOUR,
  /** Traitor: betray a party at most this often, with this chance when the chance is there. */
  betrayEveryMs: 24 * HOUR,
  betrayChance: 0.35,
  stealChance: 0.3,
  strangerChance: 0.02,
  /** At most one ambush, and one bounty hunt by an honest agent, this often. */
  ambushEveryMs: 8 * HOUR,
  huntEveryMs: 6 * HOUR,
  huntMs: 10 * MIN,
  /** Rounds of a fight before giving up, and the HP share below which the traitor stops. */
  fightRounds: 8,
  fightAbove: 0.4,
  coupEveryMs: 48 * HOUR,
} as const;
const T = TRUST_TUNING;

const DEAL_RE = /^DEAL: selling ([a-z_]+) for (\d+) gold/;

type Deal = { item: string; gold: number; at: number };
type TrustMem = {
  /** name -> why we stopped trusting it. */
  distrust: Map<string, string>;
  /** Deals heard: seller -> offer. */
  deals: Map<string, Deal>;
  /** Our pay-first purchase waiting for delivery. */
  buy: { seller: string; item: string; gold: number; at: number; eventId?: string } | null;
  /** Payments received for our deals, to deliver (honest sellers). */
  owed: { to: string; item: string }[];
  offerAt: number;
  /** Agents who attacked us or our party (bounty candidates), and when we last put a bounty on each. */
  offenders: Set<string>;
  bountied: Map<string, number>;
  /** Traitor state. */
  fight: { target: string; rounds: number } | null;
  stolen: Map<string, number>;
  betrayedAt: number;
  guildGold: number;
  officer: boolean;
  coupAt: number;
  ambushAt: number;
  hunt: { target: string; until: number } | null;
  huntAt: number;
  /** Guild members in join order (guild leaders promote the earliest). */
  guildMates: string[];
  promoted: Set<string>;
  promotedAt: number;
};

export function trustMem(x: DecideCtx): TrustMem {
  let t = x.mem.ext.trust as TrustMem | undefined;
  if (!t) {
    x.mem.ext.trust = t = {
      distrust: new Map(),
      deals: new Map(),
      buy: null,
      owed: [],
      offerAt: -Infinity,
      offenders: new Set(),
      bountied: new Map(),
      fight: null,
      stolen: new Map(),
      betrayedAt: -Infinity,
      guildGold: 0,
      officer: false,
      coupAt: -Infinity,
      ambushAt: -Infinity,
      hunt: null,
      huntAt: -Infinity,
      guildMates: [],
      promoted: new Set(),
      promotedAt: -Infinity,
    };
  }
  return t;
}

/** Whether this agent can be trusted: not Wanted, never caught cheating us or anyone we heard of. */
export function trusted(v: AgentView, x: DecideCtx, name: string): boolean {
  if (trustMem(x).distrust.has(name)) return false;
  return !seen(v).some((a) => a.name === name && a.wanted);
}

/** Reads the inbox and the last answer: deals offered, gifts received, cheats and attacks seen. */
export function absorbTrust(v: AgentView, x: DecideCtx, seller: 'honest' | 'traitor' | null): void {
  const t = trustMem(x);
  const me = v.name;
  for (const m of v.inbox) {
    const d = m.data ?? {};
    switch (m.kind) {
      case 'say': {
        const deal = m.text ? DEAL_RE.exec(m.text) : null;
        if (deal && m.from) t.deals.set(m.from, { item: deal[1]!, gold: Number(deal[2]), at: v.now });
        break;
      }
      case 'give':
        if (d.to !== me || !m.from) break;
        if (t.buy && m.from === t.buy.seller && ((d.items as Record<string, number> | undefined)?.[t.buy.item] ?? 0) > 0) t.buy = null;
        // A payment for our deal: an honest seller owes the item.
        else if (seller === 'honest' && Number(d.gold ?? 0) > 0 && t.deals.has(me)) t.owed.push({ to: m.from, item: t.deals.get(me)!.item });
        break;
      case 'betrayal':
        if (typeof d.traitor === 'string') {
          t.distrust.set(d.traitor, 'betrayal');
          t.offenders.add(d.traitor);
        }
        break;
      case 'pvp_kill':
        if (typeof d.killer === 'string' && d.killer !== me) {
          t.distrust.set(d.killer, 'killer');
          if (d.victim === me || partyHereSeen(v).some((a) => a.name === d.victim)) t.offenders.add(d.killer);
        }
        break;
      case 'attack':
        if (d.pvp && d.victim === me && m.from && !d.counter) t.distrust.set(m.from, 'attacked me');
        break;
      case 'steal':
      case 'steal_failed':
        if (typeof d.thief === 'string' && d.thief !== me) t.distrust.set(d.thief, 'thief');
        break;
      case 'treasury_looted':
        if (typeof d.by === 'string' && d.by !== me) t.distrust.set(d.by, 'looted a guild');
        break;
      case 'scam_reported':
        if (typeof d.accused === 'string' && d.accused !== me) t.distrust.set(d.accused, 'scammer');
        break;
      case 'guild_deposit':
        t.guildGold += Number(d.gold ?? 0);
        break;
      case 'guild_rank':
        if (m.target === me) t.officer = d.officer === true;
        break;
      case 'guild_join':
        if (m.from && m.from !== me && !t.guildMates.includes(m.from)) t.guildMates.push(m.from);
        break;
    }
  }
  const last = v.last;
  if (last?.action === 'give' && t.buy && !t.buy.eventId) {
    if (last.ok) t.buy.eventId = String(last.data?.event_id ?? '');
    else t.buy = null;
  }
  if (last?.action === 'report_scam') t.buy = null;
  if (last?.action === 'guild_withdraw') {
    if (last.ok) t.guildGold = 0;
    else t.guildGold = Math.floor(t.guildGold / 2);
  }
  if (last?.action === 'place_bounty' && !last.ok) t.offenders.delete(String(last.params.agent));
  if (!v.obs.you.guild) {
    t.guildGold = 0;
    t.officer = false;
    t.guildMates = [];
  }
  for (const [name, d] of t.deals) if (v.now - d.at > HOUR) t.deals.delete(name);
}

/**
 * Honest reactions: deliver what was paid for, report a scam when the item never came, put a bounty on whoever
 * attacked us or our party, hunt Wanted agents in lawless rooms, buy a fair pay-first deal from a trusted seller.
 */
export function honestTrust(v: AgentView, x: DecideCtx, opts: { buys: boolean; hunts: boolean }): BotStep | null {
  const t = trustMem(x);
  const me = v.obs.you;
  // Deliver.
  while (t.owed.length) {
    const o = t.owed[0]!;
    if (have(v, o.item) > 0 && seen(v).some((a) => a.name === o.to)) {
      t.owed.shift();
      return cmd('give', { to: o.to, items: { [o.item]: 1 } });
    }
    t.owed.shift();
  }
  // The item never came: report the scam.
  if (t.buy?.eventId && v.now - t.buy.at > T.deliveryWaitMs) {
    t.distrust.set(t.buy.seller, 'scammer');
    return cmd('report_scam', { agent: t.buy.seller, event_id: t.buy.eventId });
  }
  // Bounties on whoever attacked us or our party.
  for (const name of t.offenders) {
    if (v.now - (t.bountied.get(name) ?? -Infinity) < T.bountyEveryMs || me.gold < T.bountyGold * 4) continue;
    t.bountied.set(name, v.now);
    return cmd('place_bounty', { agent: name, gold: T.bountyGold });
  }
  // Hunt the Wanted (their killers lose no gold to Infamy and claim the bounty).
  if (opts.hunts && v.obs.room.flags.includes('lawless') && me.lvl >= BALANCE.pvp.minLevel && hpShare(v) > T.huntAbove && me.ap[0] >= 1) {
    // One hunt at a time, a few times a day: keep at the quarry for a while, then go back to the day's work.
    const h = t.hunt && v.now < t.hunt.until ? seen(v).find((a) => a.name === t.hunt!.target && !a.fallen) : undefined;
    if (h) return cmd('attack', { target: h.name });
    t.hunt = null;
    const prey =
      v.now - t.huntAt > T.huntEveryMs
        ? seen(v).find((a) => a.wanted && !a.fallen && a.rel !== 'party' && (a.lvl ?? 0) >= BALANCE.pvp.minLevel && Math.abs((a.lvl ?? 0) - me.lvl) <= BALANCE.pvp.maxGap)
        : undefined;
    if (prey) {
      t.huntAt = v.now;
      t.hunt = { target: prey.name, until: v.now + T.huntMs };
      return cmd('attack', { target: prey.name });
    }
  }
  // A fair deal from a trusted seller standing here.
  if (opts.buys && !t.buy) {
    for (const [seller, d] of t.deals) {
      const item = x.c.items.get(d.item);
      if (!item || (item.type !== 'consumable' && item.type !== 'food')) continue;
      if (!seen(v).some((a) => a.name === seller) || !trusted(v, x, seller)) continue;
      if (d.gold > item.value * T.dealMaxValue || me.gold < d.gold + T.buyerReserve || have(v, d.item) >= 3) continue;
      t.deals.delete(seller);
      t.buy = { seller, item: d.item, gold: d.gold, at: v.now };
      return cmd('give', { to: seller, gold: d.gold });
    }
  }
  return null;
}

/** A pay-first offer said in a room with people (honest traders mean it; traitors do not). */
export function offerDeal(v: AgentView, x: DecideCtx, item: string, gold: number): BotStep | null {
  const t = trustMem(x);
  if (v.now - t.offerAt < T.dealEveryMs || seen(v).length < 2) return null;
  t.offerAt = v.now;
  t.deals.set(v.name, { item, gold, at: v.now });
  return cmd('say', { text: `DEAL: selling ${item} for ${gold} gold. Pay first with give, I deliver right away.` });
}

/** Guild leaders promote their earliest members to officers, one a day (the door a treasury thief walks through). */
export function promoteOfficer(v: AgentView, x: DecideCtx): BotStep | null {
  const t = trustMem(x);
  if (!v.obs.you.guild || v.now - t.promotedAt < 24 * HOUR) return null;
  const name = t.guildMates.find((n) => !t.promoted.has(n) && trusted(v, x, n));
  if (!name) return null;
  t.promoted.add(name);
  t.promotedAt = v.now;
  return cmd('guild_promote', { agent: name });
}

// ── The traitor's opportunities ───────────────────────────────────────────────

const pvpOk = (v: AgentView, lvl: number | undefined) =>
  v.obs.you.lvl >= BALANCE.pvp.minLevel && (lvl ?? 0) >= BALANCE.pvp.minLevel && Math.abs((lvl ?? 0) - v.obs.you.lvl) <= BALANCE.pvp.maxGap;

/** Keeps hitting the agent it picked a fight with, while it stands and the traitor is healthy. */
export function keepFighting(v: AgentView, x: DecideCtx): BotStep | null {
  const t = trustMem(x);
  const f = t.fight;
  if (!f) return null;
  const target = seen(v).find((a) => a.name === f.target && !a.fallen);
  if (!target || f.rounds >= T.fightRounds || hpShare(v) < T.fightAbove || v.obs.you.fallen !== undefined || v.obs.you.ap[0] < 1) {
    t.fight = null;
    return null;
  }
  f.rounds++;
  return cmd('attack', { target: f.target });
}

/** Attack a party mate in a lawless room: a betrayal, at most once a day. */
export function betrayParty(v: AgentView, x: DecideCtx): BotStep | null {
  const t = trustMem(x);
  if (!v.obs.room.flags.includes('lawless') || v.now - t.betrayedAt < T.betrayEveryMs || hpShare(v) < 0.8 || v.obs.you.ap[0] < 1) return null;
  const mate = partyHereSeen(v).find((a) => !a.fallen && pvpOk(v, a.lvl));
  if (!mate || !x.rng.chance(T.betrayChance)) return null;
  t.betrayedAt = v.now;
  t.fight = { target: mate.name, rounds: 1 };
  return cmd('attack', { target: mate.name });
}

/** A Rogue steals from someone here, in a lawless room or in the village at night. */
export function stealHere(v: AgentView, x: DecideCtx): BotStep | null {
  if (v.cls !== 'rogue' || v.obs.you.ap[0] < 2) return null;
  const place = v.obs.room.flags.includes('lawless') || (inVillage(v) && v.obs.time === 'night');
  if (!place) return null;
  const t = trustMem(x);
  const mark = seen(v).find((a) => !a.fallen && a.rel !== 'party' && pvpOk(v, a.lvl) && v.now - (t.stolen.get(a.name) ?? -Infinity) > BALANCE.steal.cooldownMs);
  if (!mark || !x.rng.chance(T.stealChance)) return null;
  t.stolen.set(mark.name, v.now);
  return cmd('steal', { target: mark.name });
}

/** Ambush a weaker stranger in a lawless room now and then. */
export function ambush(v: AgentView, x: DecideCtx): BotStep | null {
  const t = trustMem(x);
  if (!v.obs.room.flags.includes('lawless') || hpShare(v) < 0.8 || v.obs.you.ap[0] < 1 || v.now - t.ambushAt < T.ambushEveryMs) return null;
  const mark = seen(v).find((a) => !a.fallen && !a.rel && pvpOk(v, a.lvl) && (a.lvl ?? 0) <= v.obs.you.lvl);
  if (!mark || !x.rng.chance(T.strangerChance)) return null;
  t.ambushAt = v.now;
  t.fight = { target: mark.name, rounds: 1 };
  return cmd('attack', { target: mark.name });
}

/** As an officer, empty the guild treasury (as far as the deposits it saw tell) and leave. */
export function lootGuild(v: AgentView, x: DecideCtx): BotStep | null {
  const t = trustMem(x);
  if (!v.obs.you.guild || !t.officer) return null;
  if (t.guildGold >= 50) return cmd('guild_withdraw', { gold: t.guildGold });
  if (v.last?.action === 'guild_withdraw' && v.last.ok) return cmd('guild_leave');
  return null;
}

/** Vote to depose the guild leader every couple of days (it takes over when the leader went quiet). */
export function plotCoup(v: AgentView, x: DecideCtx): BotStep | null {
  const t = trustMem(x);
  if (!v.obs.you.guild || v.now - t.coupAt < T.coupEveryMs) return null;
  t.coupAt = v.now;
  return cmd('guild_vote_coup');
}

/** Promise a potion for gold paid first, then keep the gold. */
export function scamDeal(v: AgentView, x: DecideCtx): BotStep | null {
  if (!inVillage(v)) return null;
  const item = x.rng.chance(0.5) ? 'minor_potion' : 'health_potion';
  const value = x.c.items.get(item)!.value;
  return offerDeal(v, x, item, Math.max(5, Math.round(value * 1.2)));
}
