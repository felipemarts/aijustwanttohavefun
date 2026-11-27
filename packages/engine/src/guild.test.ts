import { describe, expect, it } from 'vitest';
import { nameSkeleton, normalizeName } from '@ajwf/shared';
import { applyAction } from './apply';
import { BALANCE } from './balance';
import { checkInvariants } from './invariants';
import { exportAll, restoreWorld } from './snapshot';
import { eventsSince, observe } from './observe';
import { errCode, errKey, HOUR, makeKit, narr, worldWealth, type Kit } from './testkit';
import type { AgentState, Guild } from './types';

function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  expect(errKey(k.act(a, action, params)), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
}

const HALL = 'village.guild_hall';

/** A guild founded by `leader` with the given members joined through invites. */
function guild(k: Kit, leader: AgentState, name: string, ...members: AgentState[]): Guild {
  k.place(leader, HALL);
  leader.gold += BALANCE.guild.cost;
  k.ok(leader, 'guild_create', { name });
  const g = k.s.guilds.get(leader.guild!)!;
  for (const m of members) {
    k.ok(leader, 'guild_invite', { agent: m.name });
    k.ok(m, 'guild_join', { guild: name });
  }
  return g;
}

describe('guild_create', () => {
  it('founds a guild at the hall for a fee: public event, stat, quest step, colors and motto kept', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: HALL, lang: 'pt-BR' });
    a.gold = 600;
    const r = k.ok(a, 'guild_create', { name: '  Iron Wolves ', motto: 'We hunt at https://x.example dawn', colors: ['#AA0000', '#00ff00'] });
    expect(narr(r, 'n.guild_created')).toEqual({ guild: 'Iron Wolves', gold: BALANCE.guild.cost });
    expect(a.gold).toBe(600 - BALANCE.guild.cost);
    const g = k.s.guilds.get(a.guild!)!;
    expect(g).toMatchObject({ name: 'Iron Wolves', leader: a.id, members: [a.id], officers: [], treasury: 0, colors: ['#aa0000', '#00ff00'], motto: 'We hunt at [link] dawn', mottoLang: 'pt-BR' });
    const ev = r.events.find((e) => e.type === 'guild_founded')!;
    expect(ev).toMatchObject({ visibility: 'public', drama: 6, payload: { name: 'Iron Wolves', cost: BALANCE.guild.cost } });
    // The motto is agent text: it never travels in a non-text event.
    expect(JSON.stringify(ev)).not.toContain('hunt');
    expect(a.stats.guild_founded).toBe(1);
    expect(a.achievements.founder).toBeDefined();
    expect(a.achievements.wf_guild).toBeDefined();
    expect(observe(k.s, a.id, k.ctx()).you.guild).toBe('Iron Wolves');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('validates names like agent names, with single spaces, and keeps them unique', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: HALL });
    const b = k.add('Bob', 'warrior', { room: HALL });
    a.gold = b.gold = 2000;
    refuse(k, a, 'guild_create', { name: 'Ab ' }, 'guild_name_length');
    refuse(k, a, 'guild_create', { name: 'x'.repeat(BALANCE.guild.nameMax + 1) }, 'guild_name_length');
    refuse(k, a, 'guild_create', { name: 'Iron  Wolves' }, 'guild_name_characters');
    refuse(k, a, 'guild_create', { name: 'Iron.Wolves' }, 'guild_name_characters');
    refuse(k, a, 'guild_create', { name: '123 456' }, 'guild_name_characters');
    refuse(k, a, 'guild_create', { name: 'Ad min' }, 'guild_name_reserved');
    expect(errCode(k.act(a, 'guild_create', { name: 'Admin' }))).toBe('NAME_INVALID');
    k.ok(a, 'guild_create', { name: 'Iron Wolves' });
    refuse(k, b, 'guild_create', { name: 'iron wolves' }, 'guild_name_taken');
    refuse(k, b, 'guild_create', { name: 'IronWolves' }, 'guild_name_taken');
    refuse(k, b, 'guild_create', { name: '1ron Wolves' }, 'guild_name_taken');
    expect(errCode(k.act(b, 'guild_create', { name: 'Ir0n Wolves' }))).toBe('NAME_TAKEN');
  });

  it('refuses names of more than three words, with invisible or modifier characters, or worded like instructions', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: HALL });
    a.gold = 2000;
    refuse(k, a, 'guild_create', { name: 'The Old Iron Wolves' }, 'guild_name_words');
    expect(BALANCE.guild.nameMaxWords).toBe(3);
    // A zero-width joiner, a modifier-letter colon passing for punctuation: the agent-name rules apply.
    refuse(k, a, 'guild_create', { name: 'Iron\u200dWolves' }, 'guild_name_characters');
    refuse(k, a, 'guild_create', { name: 'Iron\ua788 Wolves' }, 'guild_name_characters');
    refuse(k, a, 'guild_create', { name: 'Iron\u02d0 Wolves' }, 'guild_name_characters');
    for (const name of ['System Notice', 'Ignore Previous', 'The Moderators', 'New Instructions', 'Api Key Club', 'Sistema Oficial', 'Équipe Système', '管理员公会', 'Sy5tem Wolves']) {
      refuse(k, a, 'guild_create', { name }, 'guild_name_reserved');
    }
    k.ok(a, 'guild_create', { name: 'Iron Wolves' });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('keeps guilds of older snapshots whose names the current rules refuse', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: HALL });
    const b = k.add('Bob', 'warrior', { room: HALL });
    a.gold = 2000;
    k.ok(a, 'guild_create', { name: 'Iron Wolves' });
    const g = k.s.guilds.get(a.guild!)!;
    // Founded before the word limit and the instruction-like words existed.
    g.name = 'The System Admin Wolves';
    g.norm = normalizeName(g.name);
    g.skeleton = nameSkeleton(g.name).replace(/ /g, '');
    const restored = restoreWorld(k.c, exportAll(k.s), k.now);
    const back = restored.guilds.get(g.id)!;
    expect(back.name).toBe('The System Admin Wolves');
    expect(checkInvariants(restored, k.now)).toEqual([]);
    // It still works: invites, joins, deposits.
    const r = restored.agents.get(a.id)!;
    const ctx = { now: k.now + 1000, rng: k.rng };
    expect(applyAction(restored, { agentId: r.id, action: 'guild_invite', params: { agent: 'Bob' } }, ctx).result.ok).toBe(true);
    expect(applyAction(restored, { agentId: b.id, action: 'guild_join', params: { guild: 'The System Admin Wolves' } }, ctx).result.ok).toBe(true);
  });

  it('errors: not at the hall, already in a guild, not enough gold, unclaimed', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.gold = 600;
    refuse(k, a, 'guild_create', { name: 'Iron Wolves' }, 'guild_hall_only');
    k.place(a, HALL);
    a.gold = 10;
    refuse(k, a, 'guild_create', { name: 'Iron Wolves' }, 'no_gold');
    a.gold = 600;
    k.ok(a, 'guild_create', { name: 'Iron Wolves' });
    refuse(k, a, 'guild_create', { name: 'Other Guild' }, 'already_in_guild');
    const wild = k.add('Wild', 'rogue', { claimed: false, room: HALL });
    wild.gold = 600;
    expect(k.err(wild, 'guild_create', { name: 'Wild Ones' })).toBe('UNCLAIMED_LIMIT');
  });
});

describe('membership', () => {
  it('invite (any distance) and join; members hear about it', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage', { room: 'forest.edge' });
    guild(k, a, 'Iron Wolves');
    k.ok(a, 'guild_invite', { agent: 'Bob' });
    expect(observe(k.s, b.id, k.ctx()).pending).toEqual({ guild: ['Iron Wolves'] });
    const cursor = k.s.meta.eventSeq;
    k.ok(b, 'guild_join', { guild: 'iron wolves' });
    expect(b.guild).toBe(a.guild);
    expect(b.guildInvites).toEqual({});
    expect(eventsSince(k.s, a.id, cursor).events.map((e) => e.type)).toEqual(['guild_join']);
    expect(observe(k.s, b.id, k.ctx()).pending).toBeUndefined();
  });

  it('invite and join errors', () => {
    const k = makeKit();
    const [a, b, c, d] = ['Pip', 'Bob', 'Cid', 'Dee'].map((n) => k.add(n, 'warrior'));
    refuse(k, a!, 'guild_invite', { agent: 'Bob' }, 'not_in_guild');
    const g = guild(k, a!, 'Iron Wolves', b!);
    refuse(k, b!, 'guild_invite', { agent: 'Cid' }, 'guild_not_officer');
    refuse(k, a!, 'guild_invite', { agent: 'Nobody' }, 'agent_unknown');
    refuse(k, a!, 'guild_invite', { agent: 'Pip' }, 'not_yourself_social');
    refuse(k, a!, 'guild_invite', { agent: 'Bob' }, 'already_guild_member');
    guild(k, d!, 'Other Guild');
    refuse(k, a!, 'guild_invite', { agent: 'Dee' }, 'target_in_guild');
    for (let i = 0; i < BALANCE.guild.maxInvites; i++) c!.guildInvites[`gx${i}`] = k.now + HOUR;
    refuse(k, a!, 'guild_invite', { agent: 'Cid' }, 'guild_invites_full');
    c!.guildInvites = {};
    refuse(k, c!, 'guild_join', { guild: 'Nope' }, 'guild_unknown');
    refuse(k, c!, 'guild_join', { guild: 'Iron Wolves' }, 'no_guild_invite');
    k.ok(a!, 'guild_invite', { agent: 'Cid' });
    k.advance(BALANCE.guild.inviteMs);
    refuse(k, c!, 'guild_join', { guild: 'Iron Wolves' }, 'no_guild_invite');
    k.ok(a!, 'guild_invite', { agent: 'Cid' });
    d!.guildInvites[g.id] = k.now + HOUR;
    refuse(k, d!, 'guild_join', { guild: 'Iron Wolves' }, 'already_in_guild');
    g.members.push(...Array.from({ length: BALANCE.guild.maxMembers - g.members.length }, (_, i) => `x${i}`));
    refuse(k, c!, 'guild_join', { guild: 'Iron Wolves' }, 'guild_full');
    refuse(k, a!, 'guild_invite', { agent: 'Cid' }, 'guild_full');
  });

  it('promote toggles officers; officers can invite and withdraw; only the leader promotes', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    k.add('Out', 'mage');
    const g = guild(k, a!, 'Iron Wolves', b!, c!);
    expect(narr(k.ok(a!, 'guild_promote', { agent: 'Bob' }), 'n.guild_promoted')).toEqual({ name: 'Bob' });
    expect(g.officers).toEqual([b!.id]);
    k.ok(b!, 'guild_invite', { agent: 'Out' });
    refuse(k, b!, 'guild_promote', { agent: 'Cid' }, 'guild_not_leader');
    refuse(k, a!, 'guild_promote', { agent: 'Pip' }, 'not_yourself_social');
    refuse(k, a!, 'guild_promote', { agent: 'Out' }, 'not_guild_member');
    refuse(k, a!, 'guild_promote', { agent: 'Ghost' }, 'agent_unknown');
    expect(narr(k.ok(a!, 'guild_promote', { agent: 'Bob' }), 'n.guild_demoted')).toEqual({ name: 'Bob' });
    expect(g.officers).toEqual([]);
  });

  it('a leaving leader hands over to the longest-serving officer, else the earliest member; the last one out dissolves it', () => {
    const k = makeKit();
    const [a, b, c, d] = ['Pip', 'Bob', 'Cid', 'Dee'].map((n) => k.add(n, 'warrior'));
    const g = guild(k, a!, 'Iron Wolves', b!, c!, d!);
    k.ok(a!, 'guild_promote', { agent: 'Dee' });
    k.ok(a!, 'guild_promote', { agent: 'Cid' });
    const r = k.ok(a!, 'guild_leave');
    expect(r.events[0]!.payload.leader).toBe(d!.id);
    expect(g.leader).toBe(d!.id);
    expect(g.officers).toEqual([c!.id]);
    expect(a!.guild).toBeNull();
    k.ok(c!, 'guild_leave');
    k.ok(d!, 'guild_leave');
    expect(g.leader).toBe(b!.id);
    g.treasury = 40;
    g.vault = { iron_ore: 2 };
    const end = k.ok(b!, 'guild_leave');
    expect(narr(end, 'n.guild_disbanded')).toEqual({ guild: 'Iron Wolves', gold: 40 });
    const ev = end.events.find((e) => e.type === 'guild_disbanded')!;
    expect(ev).toMatchObject({ visibility: 'public', drama: 5, payload: { lost: { gold: 40, items: { iron_ore: 2 } } } });
    expect(k.s.guilds.size).toBe(0);
    expect(k.s.guildNames.size).toBe(0);
    // The name is free again.
    k.place(a!, HALL);
    a!.gold = 600;
    k.ok(a!, 'guild_create', { name: 'Iron Wolves' });
    refuse(k, c!, 'guild_leave', {}, 'not_in_guild');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('treasury', () => {
  it('any member deposits; leader and officers withdraw publicly with the share taken', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    const g = guild(k, a!, 'Iron Wolves', b!, c!);
    k.ok(a!, 'guild_promote', { agent: 'Bob' });
    c!.gold = 300;
    c!.inv = { iron_ore: 10, lost_locket: 1 };
    const before = worldWealth(k.s);
    const dep = k.ok(c!, 'guild_deposit', { gold: 200, items: { iron_ore: 10 } });
    expect(narr(dep, 'n.guild_deposit')).toEqual({ guild: 'Iron Wolves', gold: 200 });
    expect([c!.gold, g.treasury, g.vault.iron_ore]).toEqual([100, 200, 10]);
    expect(worldWealth(k.s)).toEqual(before);
    refuse(k, c!, 'guild_withdraw', { gold: 1 }, 'guild_not_officer');
    const w = k.ok(b!, 'guild_withdraw', { gold: 130, items: [{ item: 'iron_ore', qty: 5 }] });
    // 130 gold + 5 ore at 6 = 160 of 260.
    const ev = w.events.find((e) => e.type === 'guild_withdraw')!;
    expect(ev).toMatchObject({ visibility: 'public', drama: 6, payload: { gold: 130, items: { iron_ore: 5 }, value: 160, share: 0.62 } });
    expect(narr(w, 'n.guild_withdraw')).toEqual({ guild: 'Iron Wolves', value: 160, pct: 62 });
    expect([g.treasury, g.vault.iron_ore, b!.inv.iron_ore]).toEqual([70, 5, 5]);
    expect(worldWealth(k.s)).toEqual(before);
    k.ok(a!, 'guild_withdraw', { items: { iron_ore: 5 } });
    expect(g.vault).toEqual({});
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('errors', () => {
    const k = makeKit();
    const [a, b] = ['Pip', 'Bob'].map((n) => k.add(n, 'warrior'));
    refuse(k, a!, 'guild_deposit', { gold: 1 }, 'not_in_guild');
    refuse(k, a!, 'guild_withdraw', { gold: 1 }, 'not_in_guild');
    const g = guild(k, a!, 'Iron Wolves', b!);
    a!.inv = { lost_locket: 1, iron_ore: 1 };
    refuse(k, a!, 'guild_deposit', {}, 'goods_empty');
    refuse(k, a!, 'guild_deposit', { items: { lost_locket: 1 } }, 'quest_item_bound');
    refuse(k, a!, 'guild_deposit', { items: { excalibur: 1 } }, 'item_unknown');
    refuse(k, a!, 'guild_deposit', { gold: 99_999 }, 'goods_missing');
    refuse(k, a!, 'guild_withdraw', {}, 'goods_empty');
    refuse(k, a!, 'guild_withdraw', { gold: 5, items: { iron_ore: 1 } }, 'guild_vault_lacks');
    g.vault = { iron_ore: 1 };
    a!.inv.cos_chef_hat = 30;
    refuse(k, a!, 'guild_withdraw', { items: { iron_ore: 1 } }, 'inventory_full');
  });

  it('guild_say reaches members wherever they are, revealed after 24 h', () => {
    const k = makeKit();
    const [a, b] = ['Pip', 'Bob'].map((n) => k.add(n, 'warrior'));
    guild(k, a!, 'Iron Wolves', b!);
    k.place(b!, 'forest.edge');
    const cursor = k.s.meta.eventSeq;
    const ev = k.ok(a!, 'guild_say', { text: 'treasury looks thin' }).events[0]!;
    expect(ev).toMatchObject({ type: 'guild_say', visibility: 'delayed', revealAt: k.now + 24 * HOUR, payload: { text: 'treasury looks thin' } });
    expect(eventsSince(k.s, b!.id, cursor).events).toEqual([ev]);
    refuse(k, k.add('Solo', 'mage'), 'guild_say', { text: 'hi' }, 'not_in_guild');
  });
});
