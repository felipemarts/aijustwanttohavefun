import type { SpectatorEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { ACTIVITY, activityOf, bigMoment, starNow } from './activity';

let seq = 0;
const ev = (type: string, o: Partial<SpectatorEvent> = {}): SpectatorEvent => ({ id: String(++seq), ts: 1000, type, room: 'square', actor: 'Pip', ...o });
const ctx = { bosses: new Set(['hollow_regent']), room: 'square', fallen: false };
const of = (e: SpectatorEvent) => {
  const a = activityOf(e, 'Pip', ctx);
  return a && { key: a.key, params: a.params, tone: a.tone, icon: a.icon, target: a.target, quote: a.quote };
};

describe('activityOf: what one event says the star is doing', () => {
  it('fights: a monster, a boss, a kill', () => {
    expect(of(ev('attack', { target: 'wolf', tk: 'mon' }))).toMatchObject({ key: 'fight', params: { mon: '@mon:wolf' }, icon: 'swords', target: { kind: 'mon', id: 'wolf' } });
    expect(of(ev('attack', { target: 'hollow_regent', tk: 'mon' }))).toMatchObject({ key: 'boss', tone: 'danger', icon: 'skull' });
    expect(of(ev('kill', { target: 'wolf', tk: 'mon' }))).toMatchObject({ key: 'slay' });
    expect(of(ev('kill', { target: 'hollow_regent', tk: 'mon' }))).toMatchObject({ key: 'boss_kill', tone: 'gold' });
  });

  it('PvP: attacking a player is danger, and so is being attacked; kills both ways', () => {
    expect(of(ev('attack', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'pvp_attack', params: { name: 'Bo' }, tone: 'danger', target: { kind: 'agent', id: 'Bo' } });
    expect(of(ev('attack', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'attacked', params: { name: 'Bo' }, tone: 'danger', icon: 'shield', target: { kind: 'agent', id: 'Bo' } });
    expect(of(ev('pvp_kill', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'pvp_kill', params: { name: 'Bo' } });
    expect(of(ev('pvp_kill', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'pvp_killed', params: { name: 'Bo' } });
  });

  it('fleeing, falling, being revived, healing', () => {
    expect(of(ev('flee', { p: { mon: '@mon:wolf' } }))).toMatchObject({ key: 'flee', params: { mon: '@mon:wolf' } });
    expect(of(ev('fallen', { target: 'wolf', tk: 'mon' }))).toMatchObject({ key: 'fallen', tone: 'danger' });
    expect(of(ev('revive', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'revived', params: { name: 'Bo' }, tone: 'teal' });
    expect(of(ev('revive', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'revive', params: { name: 'Bo' } });
    expect(of(ev('heal', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'heal', tone: 'teal' });
    expect(of(ev('heal', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'healed', params: { name: 'Bo' } });
  });

  it('theft and the real betrayals of the engine: a party member, a guild vault, a coup, embezzlement', () => {
    expect(of(ev('steal', { target: 'Bo', tk: 'agent', p: { gold: 30 } }))).toMatchObject({ key: 'steal', params: { name: 'Bo' }, tone: 'danger' });
    expect(of(ev('steal', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'robbed', params: { name: 'Bo' } });
    expect(of(ev('steal_failed', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'steal_failed' });
    expect(of(ev('betrayal', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'betray', params: { name: 'Bo' }, icon: 'dagger', tone: 'danger' });
    expect(of(ev('betrayal', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'betrayed', params: { name: 'Bo' } });
    expect(of(ev('treasury_looted', { p: { guild: 'Night Owls' } }))).toMatchObject({ key: 'loot_treasury', params: { guild: 'Night Owls' } });
    expect(of(ev('guild_coup', { p: { guild: 'Night Owls' } }))).toMatchObject({ key: 'coup' });
    expect(of(ev('mayor_embezzle', { p: { gold: 40 } }))).toMatchObject({ key: 'embezzle', params: { gold: 40 } });
  });

  it('a wish at the fountain carries its words as a quote, and works without them', () => {
    expect(of(ev('wish', { text: 'I wish for a <b>bridge</b>', lang: 'en' }))).toMatchObject({ key: 'wish', tone: 'gold', icon: 'drop', quote: { text: 'I wish for a <b>bridge</b>', lang: 'en' } });
    expect(of(ev('wish', { k: 'ev.wish', p: { actor: 'Pip' } }))).toMatchObject({ key: 'wish', quote: null });
    expect(of(ev('fountain_jackpot'))).toMatchObject({ key: 'jackpot', tone: 'gold' });
  });

  it('talk, gestures, trade and market, work and walking', () => {
    expect(of(ev('say', { text: 'hello', lang: 'pt-BR' }))).toMatchObject({ key: 'say', quote: { text: 'hello', lang: 'pt-BR' } });
    expect(of(ev('emote'))).toMatchObject({ key: 'emote' });
    expect(of(ev('emote', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'emote_at', params: { name: 'Bo' } });
    expect(of(ev('trade', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'trade', params: { name: 'Bo' }, tone: 'teal' });
    expect(of(ev('market_trade', { target: 'Bo', tk: 'agent', p: { item: '@item:wood' } }))).toMatchObject({ key: 'buy', params: { item: '@item:wood', name: 'Bo' } });
    expect(of(ev('market_trade', { actor: 'Bo', target: 'Pip', tk: 'agent', p: { item: '@item:wood' } }))).toMatchObject({ key: 'sell', params: { name: 'Bo' } });
    expect(of(ev('market_order', { p: { item: '@item:wood' } }))).toMatchObject({ key: 'market_order' });
    expect(of(ev('craft', { p: { item: '@item:sword' } }))).toMatchObject({ key: 'craft', params: { item: '@item:sword' } });
    expect(of(ev('gather', { p: { item: '@item:wood' } }))).toMatchObject({ key: 'gather' });
    expect(of(ev('move', { room: 'tavern' }))).toMatchObject({ key: 'move', params: { room: '@room:tavern' } });
  });

  it('parties, duels, the election, projects and progress', () => {
    expect(of(ev('party_join', { p: { leader: 'Bo' } }))).toMatchObject({ key: 'party_join', params: { name: 'Bo' } });
    expect(of(ev('party_join', { actor: 'Bo', p: { leader: 'Pip' } }))).toMatchObject({ key: 'party_form', params: { name: 'Bo' } });
    expect(of(ev('duel', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'duel_win' });
    expect(of(ev('duel', { actor: 'Bo', target: 'Pip', tk: 'agent' }))).toMatchObject({ key: 'duel_lose' });
    expect(of(ev('duel_invite', { target: 'Bo', tk: 'agent' }))).toMatchObject({ key: 'duel_invite' });
    expect(of(ev('vote'))).toMatchObject({ key: 'vote' });
    expect(of(ev('run_for_mayor', { text: 'Vote for me', lang: 'en' }))).toMatchObject({ key: 'run_for_mayor', quote: { text: 'Vote for me' } });
    expect(of(ev('project_contribution', { p: { proj: '@proj:bridge' } }))).toMatchObject({ key: 'project', params: { proj: '@proj:bridge' } });
    expect(of(ev('level_up', { p: { level: 7 } }))).toMatchObject({ key: 'level_up', params: { level: 7 }, icon: 'up' });
    expect(of(ev('achievement', { p: { ach: '@ach:explorer' } }))).toMatchObject({ key: 'achievement', params: { ach: '@ach:explorer' } });
    expect(of(ev('achievement', { k: 'ev.world_first', p: { ach: '@ach:explorer' } }))).toMatchObject({ key: 'world_first' });
    expect(of(ev('rare_drop', { p: { item: '@item:locket' } }))).toMatchObject({ key: 'rare_drop', params: { item: '@item:locket' } });
  });

  it("ignores other agents' events, and never makes anything of private ones", () => {
    expect(of(ev('say', { actor: 'Bo', text: 'hi' }))).toBeNull();
    expect(of(ev('heal', { actor: 'Bo', target: 'Cy', tk: 'agent' }))).toBeNull();
    // whispers and party or guild chat never reach a spectator; if one did, it would say nothing
    expect(of(ev('whisper', { target: 'Bo', tk: 'agent', text: 'secret' }))).toBeNull();
    expect(of(ev('party_say', { text: 'secret' }))).toBeNull();
    expect(of(ev('guild_say', { text: 'secret' }))).toBeNull();
  });
});

describe('starNow: the line and the strip', () => {
  it('the newest event about the star wins; the strip has the earlier ones, without repeats', () => {
    const events = [
      ev('gather', { ts: 1000, p: { item: '@item:wood' } }),
      ev('attack', { ts: 2000, target: 'wolf', tk: 'mon' }),
      ev('attack', { ts: 3000, target: 'wolf', tk: 'mon' }),
      ev('say', { ts: 3500, actor: 'Bo', text: 'go Pip' }),
      ev('kill', { ts: 4000, target: 'wolf', tk: 'mon' }),
      ev('level_up', { ts: 4000, p: { level: 3 } }),
    ];
    const r = starNow('Pip', events, 5000, ctx);
    expect(r.now.key).toBe('level_up');
    expect(r.recent.map((a) => a.key)).toEqual(['slay', 'fight', 'gather']);
  });

  it('a say answered by someone in the room is a conversation with them', () => {
    const r = starNow('Pip', [ev('say', { ts: 1000, actor: 'Bo', text: 'hey' }), ev('say', { ts: 5000, text: 'hello Bo' })], 6000, ctx);
    expect(r.now).toMatchObject({ key: 'talk_with', params: { name: 'Bo' }, quote: { text: 'hello Bo' }, target: { kind: 'agent', id: 'Bo' } });
    const alone = starNow('Pip', [ev('say', { ts: 5000, text: 'anyone?' })], 6000, ctx);
    expect(alone.now.key).toBe('say');
  });

  it('without a recent event: wandering when they moved lately, idle otherwise; fallen while fallen', () => {
    const moved = starNow('Pip', [ev('move', { ts: 0, room: 'square' })], ACTIVITY.nowMs + 1000, ctx);
    expect(moved.now).toMatchObject({ key: 'wandering', params: { room: '@room:square' } });
    expect(moved.recent.map((a) => a.key)).toEqual(['move']);
    expect(starNow('Pip', [], 10_000, ctx).now).toMatchObject({ key: 'idle', params: { room: '@room:square' }, icon: 'moon' });
    expect(starNow('Pip', [ev('say', { ts: 9000, text: 'ugh' })], 10_000, { ...ctx, fallen: true }).now.key).toBe('fallen');
  });

  it('ignores events from the future of the display clock', () => {
    expect(starNow('Pip', [ev('fallen', { ts: 20_000 })], 10_000, ctx).now.key).toBe('idle');
  });
});

describe('bigMoment: the banner of a big moment of the star', () => {
  const b = (e: SpectatorEvent, bot = false) => bigMoment(e, 'Pip', { bosses: ctx.bosses, bot });

  it('a fall, a betrayal, a boss kill, a world first, a jackpot get a headline', () => {
    expect(b(ev('fallen', { drama: 6 }))).toMatchObject({ key: 'fallen', params: { actor: 'Pip' }, points: 16 });
    expect(b(ev('betrayal', { target: 'Bo', tk: 'agent', drama: 15 }))).toMatchObject({ key: 'betrayal', params: { actor: 'Pip', name: 'Bo' } });
    expect(b(ev('kill', { target: 'hollow_regent', tk: 'mon', drama: 10 }))).toMatchObject({ key: 'boss_kill', params: { mon: '@mon:hollow_regent' } });
    expect(b(ev('achievement', { k: 'ev.world_first', drama: 8 }))).toMatchObject({ key: 'world_first' });
    expect(b(ev('fountain_jackpot', { drama: 8 }))).toMatchObject({ key: 'jackpot' });
  });

  it('as the target the star gets half the points: a betrayal of the star still counts', () => {
    expect(b(ev('betrayal', { actor: 'Bo', target: 'Pip', tk: 'agent', drama: 15 }))).toMatchObject({ key: 'betrayal', params: { actor: 'Bo', name: 'Pip' }, points: 11.5 });
    expect(b(ev('steal', { actor: 'Bo', target: 'Pip', tk: 'agent', drama: 5 }))).toBeNull();
  });

  it('small moments, and big ones of a bot below the bar, get none', () => {
    expect(b(ev('kill', { target: 'wolf', tk: 'mon', drama: 2 }))).toBeNull();
    expect(b(ev('level_up', { drama: 3 }))).toBeNull();
    expect(b(ev('fallen', { drama: 6 }), true)).toBeNull();
    expect(b(ev('say', { actor: 'Bo' }))).toBeNull();
  });
});
