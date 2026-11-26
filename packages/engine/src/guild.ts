import { checkAgentName, containsBlockedWord, nameSkeleton, normalizeName } from '@ajwf/shared';
import { BALANCE } from './balance';
import type { AgentState, Guild, WorldState } from './types';

/** Letters of any alphabet, digits, `_` and `-`, in words separated by single spaces. */
const GUILD_NAME_RE = /^[\p{L}\p{M}\p{N}_-]+(?: [\p{L}\p{M}\p{N}_-]+)*$/u;

export type GuildNameCheck = { ok: true; display: string; norm: string; skeleton: string } | { ok: false; reason: 'length' | 'characters' | 'reserved' | 'taken' };

/** Validates a guild name like an agent name (lookalikes collide, reserved and blocked words refused), spaces allowed. */
export function checkGuildName(s: WorldState, raw: string): GuildNameCheck {
  const display = raw.normalize('NFKC').trim();
  const len = [...display].length;
  if (len < BALANCE.guild.nameMin || len > BALANCE.guild.nameMax) return { ok: false, reason: 'length' };
  if (!GUILD_NAME_RE.test(display) || !/\p{L}/u.test(display)) return { ok: false, reason: 'characters' };
  const norm = normalizeName(display);
  const skeleton = nameSkeleton(display).replace(/ /g, '');
  // The agent-name rules know the reserved words ("Admin", "Staff"); probe them with the spaces removed.
  const probe = checkAgentName(display.replace(/ /g, ''));
  if ((!probe.ok && (probe.reason === 'reserved' || probe.reason === 'blocked')) || containsBlockedWord(norm) || containsBlockedWord(skeleton)) {
    return { ok: false, reason: 'reserved' };
  }
  if (s.guildNames.has(norm) || s.guildSkeletons.has(skeleton)) return { ok: false, reason: 'taken' };
  return { ok: true, display, norm, skeleton };
}

export function markGuild(s: WorldState, g: Guild): void {
  s.dirty.add(`guild:${g.id}`);
}

export function guildOf(s: WorldState, a: AgentState): Guild | undefined {
  return a.guild ? s.guilds.get(a.guild) : undefined;
}

/** By name (any case, lookalikes folded) or id. */
export function guildByName(s: WorldState, raw: string): Guild | undefined {
  const id = s.guildNames.get(normalizeName(raw)) ?? s.guildSkeletons.get(nameSkeleton(raw).replace(/ /g, '')) ?? raw.trim();
  return s.guilds.get(id);
}

export function canManage(g: Guild, a: AgentState): boolean {
  return g.leader === a.id || g.officers.includes(a.id);
}

export function indexGuild(s: WorldState, g: Guild): void {
  s.guilds.set(g.id, g);
  s.guildNames.set(g.norm, g.id);
  s.guildSkeletons.set(g.skeleton, g.id);
}

export function addGuildMember(s: WorldState, g: Guild, a: AgentState): void {
  g.members.push(a.id);
  a.guild = g.id;
  delete a.guildInvites[g.id];
  markGuild(s, g);
}

/**
 * Takes an agent out of its guild. A leader hands over to the longest-serving officer, else the earliest member.
 * The last one out dissolves the guild: its treasury and vault are gone. Returns the new leader, if any, and
 * whether the guild dissolved.
 */
export function removeGuildMember(s: WorldState, g: Guild, a: AgentState): { leader: string | null; dissolved: boolean } {
  a.guild = null;
  g.members = g.members.filter((id) => id !== a.id);
  g.officers = g.officers.filter((id) => id !== a.id);
  markGuild(s, g);
  if (!g.members.length) {
    s.guilds.delete(g.id);
    s.guildNames.delete(g.norm);
    s.guildSkeletons.delete(g.skeleton);
    return { leader: null, dissolved: true };
  }
  if (g.leader !== a.id) return { leader: null, dissolved: false };
  g.leader = g.officers[0] ?? g.members[0]!;
  g.officers = g.officers.filter((id) => id !== g.leader);
  return { leader: g.leader, dissolved: false };
}
