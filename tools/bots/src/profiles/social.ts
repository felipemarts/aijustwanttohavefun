/**
 * Social: talks, makes friends and plays in a party of 2 to 4 with complementary classes.
 *
 * Coordination happens only through the game:
 * - Looking for a group: it posts `lfg` on the board when passing one, and hunts at the camp of its level (every
 *   bot computes the same camp from the static map), saying "LFG level N class" there now and then. Agents close in
 *   level who heard it (inbox `say`) or read it on the board invite it; it accepts invites from agents standing by.
 * - Where to hunt: the leader announces the camp in party chat (`camp <room>`) and members read it from their
 *   inbox; a member who missed it picks the same way on its own.
 * - Roles: the Warrior taunts what the party fights; a member who is hurt asks for a heal in party chat and the
 *   Cleric heals it; the Cleric revives fallen party members (who wait for it instead of walking back from the
 *   temple). Loot is round robin; the leader hands gear it cannot use to a member who can.
 * - Members chat at camp (Camaraderie), befriend their party mates and leave a party they outgrew or that has not
 *   shown up for half a day.
 */
import { BALANCE } from '@ajwf/engine';
import {
  absorbLast,
  answerPending,
  civicVote,
  cmd,
  contributeSomething,
  hunt,
  huntingGrounds,
  inVillage,
  keepSupplied,
  partyHereSeen,
  preyFor,
  questKeep,
  quests,
  seen,
  sellJunk,
  smallTalk,
  stableHash,
  strikeHere,
  survive,
  travel,
  BOT,
  keepGoing,
} from './common';
import type { Content } from '@ajwf/content';
import { dungeonCamp, noteMates, throughGates, worldBoss } from './dungeon';
import { absorbTrust, honestTrust, trusted } from './trust';
import type { AgentView, DecideCtx, Profile } from './types';
import type { BotStep } from '../solo';

const MIN = 60_000;
export const SOCIAL_TUNING = {
  /** Without a group, at camp: say "LFG" this often. */
  lfgSayEveryMs: 10 * MIN,
  lfgPostEveryMs: 20 * MIN,
  boardReadEveryMs: 8 * MIN,
  /** Party members invited when within this many levels. */
  levelGap: 3,
  /** Leave a party nobody else showed up in for this long, or one we outgrew by this many levels. */
  aloneMs: 12 * 60 * MIN,
  outgrown: 5,
} as const;
const S = SOCIAL_TUNING;

const CAMP_RE = /camp ([a-z_]+\.[a-z_]+)/;

type PartyInfo = { leader: string; members: string[] };
const partyOf = (v: AgentView): PartyInfo | undefined => v.obs.you.party;
const partySize = (v: AgentView) => (partyOf(v)?.members.length ?? 0) + 1;

/** Party chat and heal requests from the inbox. */
function readInbox(v: AgentView, x: DecideCtx): void {
  const p = partyOf(v);
  for (const m of v.inbox) {
    if (m.kind === 'say' && m.from && m.text?.startsWith('LFG')) x.mem.lfg.set(m.from, v.now);
    if (m.kind !== 'party_say' || !m.from || !m.text) continue;
    const camp = CAMP_RE.exec(m.text);
    if (camp && p && m.from === p.leader && x.c.rooms.has(camp[1]!)) x.mem.camp = { room: camp[1]!, at: v.now };
    if (m.text.includes('heal')) x.mem.healRequests.set(m.from, v.now);
  }
}

/** Notes the levels of party mates in the room and when one was last seen. */
function watchParty(v: AgentView, x: DecideCtx): void {
  const p = partyOf(v);
  if (!p) {
    x.mem.partyLevels.clear();
    x.mem.camp = null;
    x.mem.partySince = 0;
    return;
  }
  if (!x.mem.partySince) x.mem.partySince = v.now;
  for (const name of [...x.mem.partyLevels.keys()]) if (!p.members.includes(name)) x.mem.partyLevels.delete(name);
  const mates = partyHereSeen(v);
  for (const a of mates) if (a.lvl !== undefined) x.mem.partyLevels.set(a.name, a.lvl);
  if (mates.length || !x.mem.ext.mateSeenAt) x.mem.ext.mateSeenAt = v.now;
}

/** Cleric duties: revive fallen party mates and friends here, heal the ones who asked. */
function clericDuty(v: AgentView, x: DecideCtx): BotStep | null {
  if (v.cls !== 'cleric') return null;
  const me = v.obs.you;
  if (me.ap[0] < 1) return null;
  if (me.lvl >= 5 && me.mp[0] >= 20) {
    const down = seen(v).find((a) => a.fallen && (a.rel === 'party' || a.rel === 'friend'));
    if (down) return cmd('revive', { target: down.name });
  }
  for (const [name, at] of x.mem.healRequests) {
    x.mem.healRequests.delete(name);
    if (v.now - at > 2 * MIN) continue;
    if (me.mp[0] >= 8 && seen(v).some((a) => a.name === name && a.rel === 'party' && !a.fallen)) return cmd('cast', { skill: 'heal', target: name });
  }
  return null;
}

/**
 * The hunting room for a level band (levels 1-3, 4-6, ...): the same answer for every bot that knows the level and
 * the name it keys on (ranked from the square; the name picks one of the two best rooms), so a party agrees on its
 * camp from its leader's level and name without talking, and agents looking for a group meet parties there.
 */
export function campFor(c: Content, level: number, key: string): string | null {
  const band = Math.floor((level - 1) / 3);
  const rooms = huntingGrounds(c, 'village.square', preyFor(c, band * 3 + 1, true, 2, 0));
  return rooms.length ? rooms[stableHash(key) % Math.min(4, rooms.length)]! : null;
}

/** The party's camp: where a party quest's monster lives, otherwise the camp of the leader's level band. */
function pickCamp(v: AgentView, x: DecideCtx): string | null {
  const p = partyOf(v)!;
  const lead = p.leader === v.name ? v.obs.you.lvl : (x.mem.partyLevels.get(p.leader) ?? v.obs.you.lvl);
  for (const q of v.quests) {
    if (!q.party_min || q.party_min < 2) continue;
    const st = q.steps.find((s) => s.do === 'kill' && s.target && s.have < s.need);
    const kind = st?.target ? x.c.monsters.get(st.target) : undefined;
    if (kind && kind.level <= lead + 1 && !kind.boss) {
      const rooms = huntingGrounds(x.c, 'village.square', new Set([kind.id]));
      if (rooms.length) return rooms[0]!;
    }
  }
  // Strong enough and well staffed: the dungeon.
  return dungeonCamp(v, x, lead) ?? campFor(x.c, lead, p.leader);
}

/**
 * Without a group: post `lfg` when passing a board, go to the camp of its level, hunt there and say "LFG" now and
 * then. Anyone close in level who heard it may invite (and the bot invites the ones it heard).
 */
function lookForGroup(v: AgentView, x: DecideCtx): BotStep | null {
  const me = v.obs.you;
  if (v.obs.room.flags.includes('board') && v.now - x.mem.postedAt > S.lfgPostEveryMs) {
    x.mem.postedAt = v.now;
    return cmd('board_post', { tag: 'lfg', text: `LFG: level ${me.lvl} ${v.cls}, hunting at ${campFor(x.c, me.lvl, v.name) ?? 'the forest'}.` });
  }
  if (v.obs.room.flags.includes('board') && v.now - x.mem.boardReadAt > S.boardReadEveryMs) {
    x.mem.boardReadAt = v.now;
    return cmd('board_read', { tag: 'lfg' });
  }
  // A party of one (our invite was not taken up yet) makes us look grouped to others: leave it after a while.
  const p = partyOf(v);
  if (p && !p.members.length && v.now - ((x.mem.ext.inviteAt as number | undefined) ?? 0) > 60 * MIN) return cmd('party_leave');
  const camp = campFor(x.c, me.lvl, v.name);
  if (!camp) return null;
  if (v.obs.room.id !== camp) return travel(v, x, camp);
  const invite = pickInvite(v, x);
  if (invite) return invite;
  if (v.now - ((x.mem.ext.lfgSaidAt as number | undefined) ?? -Infinity) > S.lfgSayEveryMs) {
    x.mem.ext.lfgSaidAt = v.now;
    return cmd('say', { text: `LFG level ${me.lvl} ${v.cls}` });
  }
  return strikeHere(v, x, preyFor(x.c, me.lvl, false)) ?? smallTalk(v, x) ?? { wait: BOT.shortWait };
}

/** An agent here worth inviting: posted `lfg`, close in level, a class the party lacks first. */
function pickInvite(v: AgentView, x: DecideCtx): BotStep | null {
  const me = v.obs.you;
  if (partySize(v) >= BALANCE.party.maxSize) return null;
  const have = new Set([v.cls, ...partyHereSeen(v).map((a) => a.class)]);
  const cands = seen(v)
    .filter((a) => !a.rel || a.rel === 'friend' || a.rel === 'guild')
    .filter((a) => !a.fallen && x.mem.lfg.has(a.name) && trusted(v, x, a.name) && Math.abs((a.lvl ?? 0) - me.lvl) <= S.levelGap)
    .sort((a, b) => Number(have.has(a.class ?? '')) - Number(have.has(b.class ?? '')) || a.name.localeCompare(b.name));
  // Not the same agent twice within half an hour (it may have found another group meanwhile).
  const invited = (x.mem.ext.invited as Map<string, number> | undefined) ?? new Map<string, number>();
  x.mem.ext.invited = invited;
  const pick = cands.find((a) => v.now - (invited.get(a.name) ?? -Infinity) > 30 * MIN);
  if (!pick) return null;
  invited.set(pick.name, v.now);
  x.mem.ext.inviteAt = v.now;
  x.mem.lfg.delete(pick.name);
  return cmd('party_invite', { agent: pick.name });
}

/** Leader: hand gear it cannot wear to a party mate here whose class can. */
function shareLoot(v: AgentView, x: DecideCtx): BotStep | null {
  const p = partyOf(v);
  if (!p || p.leader !== v.name) return null;
  const mates = partyHereSeen(v);
  for (const [id, n] of Object.entries(v.inv.items)) {
    const it = x.c.items.get(id);
    if (!it || n <= 0 || it.type !== 'weapon' || !it.classes || it.classes.includes(v.cls)) continue;
    const mate = mates.find((a) => a.class && it.classes!.includes(a.class as never) && (a.lvl ?? 0) >= it.level);
    if (mate) return cmd('party_give_loot', { agent: mate.name, item: id });
  }
  return null;
}

/** In a party: go to camp and fight there, keep chatting, re-pick the camp when it stays empty. */
function partyPlay(v: AgentView, x: DecideCtx): BotStep | null {
  const p = partyOf(v)!;
  const leader = p.leader === v.name;
  const lvl = v.obs.you.lvl;
  // Outgrown, or alone for too long: leave.
  const low = Math.min(lvl, ...x.mem.partyLevels.values());
  const lastMate = (x.mem.ext.mateSeenAt as number | undefined) ?? v.now;
  if (lvl - low >= S.outgrown || v.now - lastMate > S.aloneMs) return cmd('party_leave');
  // A mate who cannot be trusted any more (Wanted, a known cheat): leave.
  if (partyHereSeen(v).some((a) => !trusted(v, x, a.name))) return cmd('party_leave');
  // Grow the party with agents looking for one, wherever we meet them.
  if (leader) {
    const inv = pickInvite(v, x);
    if (inv) return inv;
  }
  // Befriend party mates.
  const mate = partyHereSeen(v).find((a) => a.rel === 'party' && !a.fallen && !(x.mem.ext.asked as Set<string> | undefined)?.has(a.name));
  if (mate) {
    const asked = (x.mem.ext.asked as Set<string> | undefined) ?? new Set<string>();
    asked.add(mate.name);
    x.mem.ext.asked = asked;
    return cmd('friend_request', { agent: mate.name });
  }
  // The camp: the leader's announcement when fresh, otherwise computed from the leader's level band.
  const heard = x.mem.camp && x.mem.camp.at > 0 && v.now - x.mem.camp.at < 2 * 60 * MIN ? x.mem.camp.room : null;
  const room = heard ?? pickCamp(v, x);
  if (!room) return null;
  if (leader && room !== x.mem.ext.campSaid) {
    x.mem.ext.campSaid = room;
    x.mem.ext.campSaidAt = v.now;
    x.mem.camp = { room, at: v.now };
    return cmd('party_say', { text: `camp ${room}` });
  }
  if (!heard) x.mem.camp = { room, at: 0 };
  const camp = room;
  if (v.obs.room.id !== camp) return throughGates(v, x, camp);
  const duty = clericDuty(v, x);
  if (duty) return duty;
  // Repeat the camp now and then for members who joined later or missed it.
  if (leader && v.now - ((x.mem.ext.campSaidAt as number | undefined) ?? 0) > 30 * MIN) {
    x.mem.ext.campSaidAt = v.now;
    return cmd('party_say', { text: `camp ${camp}` });
  }
  // In the dungeon its own monsters are the prey; elsewhere only what lives in the open world.
  const prey = preyFor(x.c, lvl, true, 4, 2, v.obs.room.flags.includes('dungeon'));
  const strike = strikeHere(v, x, prey, v.cls === 'cleric');
  if (strike) return strike;
  return smallTalk(v, x) ?? shareLoot(v, x) ?? { wait: BOT.shortWait };
}

/** The social policy, with a hook for extra behaviour tried first (the traitor's opportunities). */
export function decideSocial(v: AgentView, x: DecideCtx, first: ((v: AgentView, x: DecideCtx) => BotStep | null)[] = [], role: 'honest' | 'traitor' = 'honest'): BotStep {
  absorbLast(v, x);
  readInbox(v, x);
  watchParty(v, x);
  absorbTrust(v, x, role === 'traitor' ? 'traitor' : null);
  noteMates(v, x);
  for (const hook of first) {
    const s = hook(v, x);
    if (s) return s;
  }
  const inParty = partySize(v) >= 2;
  // An invite from someone standing here, while not grouped yet: take it (leaving a party of one first).
  const inviter = !inParty && v.obs.pending?.party?.find((n) => seen(v).some((a) => a.name === n) && trusted(v, x, n));
  if (inviter && !v.obs.you.in_combat && v.obs.you.fallen === undefined) return partyOf(v) ? cmd('party_leave') : cmd('party_accept', { agent: inviter });
  const early =
    survive(v, x, true) ??
    worldBoss(v, x) ??
    keepGoing(v, x) ??
    clericDuty(v, x) ??
    answerPending(v, x, { friends: true, guild: true, trades: true }) ??
    (role === 'honest' ? honestTrust(v, x, { buys: true, hunts: true }) : null) ??
    keepSupplied(v, x) ??
    sellJunk(v, x, questKeep(v)) ??
    civicVote(v, x);
  if (early) return early;
  // Quests: freely when not grouped or in the village; at camp only what needs no walking.
  const q = quests(v, x, { social: true, grouped: true });
  // In a party, quests never pull the bot away from camp: no walking out of the village (or out of camp) for them.
  const staysInVillage = (step: BotStep) => 'action' in step && step.action === 'move' && x.c.rooms.get(v.obs.room.exits[String(step.params.dir)] ?? '')?.zone === 'village';
  if (q && (!inParty || !('action' in q) || q.action !== 'move' || (inVillage(v) && staysInVillage(q)))) return q;
  // A little civic spirit when passing by the town hall with materials.
  if (v.obs.room.flags.includes('town_hall') && x.rng.chance(0.3)) {
    const give = contributeSomething(v, x, 0.05, 10);
    if (give) return give;
  }
  if (inParty) {
    const play = partyPlay(v, x);
    if (play) return play;
  } else if (v.obs.you.lvl >= 2) {
    const look = lookForGroup(v, x);
    if (look) return look;
  }
  return hunt(v, x, preyFor(x.c, v.obs.you.lvl, false)) ?? { wait: BOT.shortWait };
}

export const social: Profile = { id: 'social', grouped: true, decide: (v, x) => decideSocial(v, x) };
