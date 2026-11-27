import { maskBlockedWords, MAX_SAY_LEN, sanitizeAgentText } from '@ajwf/shared';
import { bump, canFit } from '../agent';
import { BALANCE } from '../balance';
import { goodsValue, goodsView, isEmpty, missingGoods, parseGoods, putGoods, takeGoods } from '../goods';
import { addGuildMember, canManage, checkGuildName, guildByName, guildOf, indexGuild, markGuild, removeGuildMember, setLeader } from '../guild';
import { questEvent } from '../quests';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import type { AgentState, Goods, Guild } from '../types';
import { chatCooldown, REVEAL_AFTER_MS } from './chat';
import { agentByName, cleanText, hasFlag, type HandlerMap } from './util';

/** Banner colors when the founder picks none: earthy brown on parchment. */
const DEFAULT_COLORS: [string, string] = ['#6b4f2a', '#e8d8a8'];

function myGuild(run: Run, a: AgentState): Guild {
  const g = guildOf(run.s, a);
  if (!g) fail('NOT_ALLOWED', 'not_in_guild');
  return g;
}

function managedGuild(run: Run, a: AgentState): Guild {
  const g = myGuild(run, a);
  if (!canManage(g, a)) fail('NOT_ALLOWED', 'guild_not_officer');
  return g;
}

function vaultValue(run: Run, g: Guild): number {
  return goodsValue(run, { gold: g.treasury, items: Object.entries(g.vault).map(([item, qty]) => ({ item, qty })) });
}

/** What the guild lacks to pay out these goods, as "item xN" strings. */
function vaultLacks(g: Guild, goods: Goods): string[] {
  const out: string[] = [];
  if (g.treasury < goods.gold) out.push(`gold x${goods.gold - g.treasury}`);
  for (const s of goods.items) if ((g.vault[s.item] ?? 0) < s.qty) out.push(`${s.item} x${s.qty - (g.vault[s.item] ?? 0)}`);
  return out;
}

function liveInvites(inv: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(inv).filter(([, until]) => until > now));
}

/** Leadership changes hands by force: the old leader stays on as a plain member. */
function coup(run: Run, g: Guild, b: AgentState, reason: 'inactive' | 'vote'): void {
  const old = run.s.agents.get(g.leader)?.name ?? '?';
  setLeader(g, b.id);
  markGuild(run.s, g);
  bump(run, b, 'coups_won');
  markAgent(run.s, b);
  tell(run, run.actor === b ? 'n.coup_won' : 'n.coup_done', { guild: g.name, name: b.name, old });
  emit(run, 'guild_coup', {
    room: b.room,
    actor: b.id,
    target: g.id,
    vis: 'public',
    to: g.members,
    drama: 9,
    m: msg(reason === 'inactive' ? 'ev.guild_coup_inactive' : 'ev.guild_coup', { actor: b.name, name: old, guild: g.name }),
    data: { guild: g.name, old, new: b.name, reason },
  });
}

export const guildActions: HandlerMap = {
  guild_create(run, a, p) {
    if (!hasFlag(run, a, 'guild_hall')) fail('NOT_AVAILABLE_HERE', 'guild_hall_only');
    if (a.guild) fail('CONFLICT', 'already_in_guild');
    const G = BALANCE.guild;
    const name = checkGuildName(run.s, p.name);
    if (!name.ok) {
      const np = { name: p.name, min: G.nameMin, max: G.nameMax };
      if (name.reason === 'taken') fail('NAME_TAKEN', 'guild_name_taken', np);
      if (name.reason === 'length') fail('NAME_INVALID', 'guild_name_length', np);
      if (name.reason === 'characters') fail('NAME_INVALID', 'guild_name_characters', np);
      fail('NAME_INVALID', 'guild_name_reserved', np);
    }
    if (a.gold < G.cost) fail('NOT_ENOUGH_GOLD', 'no_gold', { need: G.cost, have: a.gold });
    const motto = p.motto ? maskBlockedWords(sanitizeAgentText(p.motto, G.mottoMax).text) : '';
    const s = run.s;
    const g: Guild = {
      id: `g${(++s.meta.guildSeq).toString(36)}`,
      name: name.display,
      norm: name.norm,
      skeleton: name.skeleton,
      motto,
      mottoLang: a.lang,
      colors: p.colors ? [p.colors[0].toLowerCase(), p.colors[1].toLowerCase()] : DEFAULT_COLORS,
      leader: a.id,
      officers: [],
      members: [a.id],
      treasury: 0,
      vault: {},
      createdAt: run.now,
      coup: [],
    };
    // The fee is a gold sink: it leaves the economy.
    a.gold -= G.cost;
    a.guild = g.id;
    a.guildInvites = {};
    indexGuild(s, g);
    markGuild(s, g);
    s.dirty.add('meta');
    tell(run, 'n.guild_created', { guild: g.name, gold: G.cost });
    // The motto is agent-written text: it stays in the guild record, never in event text.
    emit(run, 'guild_founded', {
      room: a.room,
      actor: a.id,
      target: g.id,
      vis: 'public',
      to: 'room',
      drama: 6,
      m: msg('ev.guild_founded', { actor: a.name, guild: g.name }),
      data: { guild: g.id, name: g.name, colors: g.colors, cost: G.cost },
    });
    bump(run, a, 'guild_founded');
    questEvent(run, a, 'guild');
  },

  guild_invite(run, a, p) {
    const g = managedGuild(run, a);
    const b = agentByName(run, p.agent);
    if (!b) fail('TARGET_NOT_FOUND', 'agent_unknown', { name: p.agent });
    if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
    if (b.guild) fail('CONFLICT', b.guild === g.id ? 'already_guild_member' : 'target_in_guild', { name: b.name });
    const G = BALANCE.guild;
    if (g.members.length >= G.maxMembers) fail('CONFLICT', 'guild_full', { max: G.maxMembers });
    const invites = liveInvites(b.guildInvites, run.now);
    if (invites[g.id] === undefined && Object.keys(invites).length >= G.maxInvites) fail('CONFLICT', 'guild_invites_full', { name: b.name });
    b.guildInvites = { ...invites, [g.id]: run.now + G.inviteMs };
    markAgent(run.s, b);
    tell(run, 'n.guild_invite', { name: b.name, guild: g.name });
    emit(run, 'guild_invite', { room: a.room, actor: a.id, target: b.id, vis: 'private', to: [b.id], m: msg('ev.guild_invite', { actor: a.name, guild: g.name }), data: { guild: g.id, name: g.name } });
  },

  guild_join(run, a, p) {
    const g = guildByName(run.s, p.guild);
    if (!g) fail('TARGET_NOT_FOUND', 'guild_unknown', { guild: p.guild });
    if (a.guild) fail('CONFLICT', 'already_in_guild');
    if ((a.guildInvites[g.id] ?? 0) <= run.now) fail('NOT_ALLOWED', 'no_guild_invite', { guild: g.name });
    if (g.members.length >= BALANCE.guild.maxMembers) fail('CONFLICT', 'guild_full', { max: BALANCE.guild.maxMembers });
    a.guildInvites = liveInvites(a.guildInvites, run.now);
    addGuildMember(run.s, g, a);
    tell(run, 'n.guild_joined', { guild: g.name, n: g.members.length });
    emit(run, 'guild_join', { room: a.room, actor: a.id, target: g.id, vis: 'public', to: g.members, drama: 1, m: msg('ev.guild_join', { actor: a.name, guild: g.name }) });
    questEvent(run, a, 'guild');
  },

  guild_leave(run, a) {
    const g = myGuild(run, a);
    const lost = { gold: g.treasury, items: { ...g.vault } };
    const res = removeGuildMember(run.s, g, a);
    if (res.dissolved) {
      tell(run, 'n.guild_disbanded', { guild: g.name, gold: lost.gold });
      emit(run, 'guild_disbanded', {
        room: a.room,
        actor: a.id,
        target: g.id,
        vis: 'public',
        drama: lost.gold > 0 || Object.keys(lost.items).length ? 5 : 2,
        m: msg('ev.guild_disbanded', { actor: a.name, guild: g.name, gold: lost.gold }),
        data: { guild: g.id, name: g.name, lost },
      });
      return;
    }
    const leader = res.leader ? run.s.agents.get(res.leader)!.name : '';
    tell(run, 'n.guild_left', { guild: g.name });
    emit(run, 'guild_leave', {
      room: a.room,
      actor: a.id,
      target: g.id,
      to: g.members,
      drama: leader ? 2 : 1,
      m: msg(leader ? 'ev.guild_leave_leader' : 'ev.guild_leave', { actor: a.name, guild: g.name, leader }),
      data: { guild: g.id, ...(res.leader ? { leader: res.leader } : {}) },
    });
  },

  guild_promote(run, a, p) {
    const g = myGuild(run, a);
    if (g.leader !== a.id) fail('NOT_ALLOWED', 'guild_not_leader');
    const b = agentByName(run, p.agent);
    if (!b) fail('TARGET_NOT_FOUND', 'agent_unknown', { name: p.agent });
    if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
    if (b.guild !== g.id) fail('NOT_ALLOWED', 'not_guild_member', { name: b.name, guild: g.name });
    const promoted = !g.officers.includes(b.id);
    g.officers = promoted ? [...g.officers, b.id] : g.officers.filter((id) => id !== b.id);
    markGuild(run.s, g);
    tell(run, promoted ? 'n.guild_promoted' : 'n.guild_demoted', { name: b.name });
    emit(run, 'guild_rank', {
      room: a.room,
      actor: a.id,
      target: b.id,
      to: g.members,
      m: msg(promoted ? 'ev.guild_promoted' : 'ev.guild_demoted', { actor: a.name, name: b.name, guild: g.name }),
      data: { guild: g.id, officer: promoted },
    });
  },

  guild_deposit(run, a, p) {
    const g = myGuild(run, a);
    const goods = parseGoods(run, p);
    if (isEmpty(goods)) fail('INVALID_PARAMS', 'goods_empty');
    const missing = missingGoods(a, goods);
    if (missing.length) fail('MISSING_ITEMS', 'goods_missing', { missing: missing.join(', ') });
    takeGoods(a, goods);
    g.treasury += goods.gold;
    for (const s of goods.items) g.vault[s.item] = (g.vault[s.item] ?? 0) + s.qty;
    markGuild(run.s, g);
    tell(run, 'n.guild_deposit', { guild: g.name, gold: g.treasury });
    emit(run, 'guild_deposit', { room: a.room, actor: a.id, target: g.id, to: g.members, m: msg('ev.guild_deposit', { actor: a.name, guild: g.name, value: goodsValue(run, goods) }), data: { guild: g.id, ...goodsView(goods) } });
  },

  guild_withdraw(run, a, p) {
    const g = managedGuild(run, a);
    const goods = parseGoods(run, p);
    if (isEmpty(goods)) fail('INVALID_PARAMS', 'goods_empty');
    const lacks = vaultLacks(g, goods);
    if (lacks.length) fail('MISSING_ITEMS', 'guild_vault_lacks', { guild: g.name, missing: lacks.join(', ') });
    if (!canFit(run.c, a, goods.items)) fail('INVENTORY_FULL', 'inventory_full');
    const before = vaultValue(run, g);
    const value = goodsValue(run, goods);
    // The share of the treasury taken is public: it is how a looted guild is spotted.
    const share = before > 0 ? Math.round((value / before) * 100) / 100 : 1;
    g.treasury -= goods.gold;
    for (const s of goods.items) {
      const left = g.vault[s.item]! - s.qty;
      if (left > 0) g.vault[s.item] = left;
      else delete g.vault[s.item];
    }
    putGoods(run, a, goods);
    markGuild(run.s, g);
    tell(run, 'n.guild_withdraw', { guild: g.name, value, pct: Math.round(share * 100) });
    emit(run, 'guild_withdraw', {
      room: a.room,
      actor: a.id,
      target: g.id,
      vis: 'public',
      to: g.members,
      drama: share >= 0.5 ? 6 : 2,
      m: msg('ev.guild_withdraw', { actor: a.name, guild: g.name, value, pct: Math.round(share * 100) }),
      data: { guild: g.id, ...goodsView(goods), value, share },
    });
    // Half the treasury or more in one go: the guild has been looted, and everyone hears of it.
    const L = BALANCE.loot;
    if (before >= L.minValue && value >= before * L.share) {
      bump(run, a, 'treasury_looted');
      emit(run, 'treasury_looted', {
        room: a.room,
        actor: a.id,
        target: g.id,
        vis: 'public',
        to: g.members,
        drama: 12,
        m: msg('ev.treasury_looted', { actor: a.name, guild: g.name, value, pct: Math.round(share * 100) }),
        data: { guild: g.name, by: a.name, value, share },
      });
    }
  },

  guild_vote_coup(run, a) {
    const g = myGuild(run, a);
    if (g.leader === a.id) fail('NOT_ALLOWED', 'coup_leader');
    const C = BALANCE.coup;
    const leader = run.s.agents.get(g.leader);
    // Banned or retired leaders count as inactive.
    const inactive = !leader || leader.status !== 'active' || run.now - leader.lastActiveAt >= C.inactiveMs;
    if (inactive && g.officers.includes(a.id)) {
      coup(run, g, a, 'inactive');
      return;
    }
    const need = Math.max(1, Math.ceil(C.voteShare * g.members.length - 1e-9));
    if (g.coup.includes(a.id)) fail('CONFLICT', 'coup_already_voted', { n: g.coup.length, need });
    g.coup.push(a.id);
    markGuild(run.s, g);
    if (g.coup.length < need) {
      tell(run, 'n.coup_vote', { n: g.coup.length, need, guild: g.name });
      emit(run, 'guild_coup_vote', {
        room: a.room,
        actor: a.id,
        target: g.id,
        vis: 'private',
        to: g.members,
        drama: 3,
        m: msg('ev.guild_coup_vote', { actor: a.name, guild: g.name, n: g.coup.length, need }),
        data: { guild: g.id, votes: g.coup.length, need },
      });
      return;
    }
    // Enough votes: the longest-serving officer among the voters takes over, else the longest-serving officer,
    // else (a guild without officers) the first member who voted.
    const voters = new Set(g.coup);
    const next = g.officers.find((id) => voters.has(id)) ?? g.officers[0] ?? g.coup[0]!;
    coup(run, g, run.s.agents.get(next)!, 'vote');
  },

  guild_say(run, a, p) {
    const g = myGuild(run, a);
    const text = cleanText(p.text, MAX_SAY_LEN);
    chatCooldown(run, a);
    tell(run, 'n.guild_say', { n: g.members.length - 1 });
    emit(run, 'guild_say', { room: a.room, actor: a.id, target: g.id, vis: 'delayed', revealAt: run.now + REVEAL_AFTER_MS, to: g.members, lang: a.lang, data: { text } });
  },
};
