import type { GameEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_KEYS, HighlightDetector, HOT_RUMOR_REPLIES, JOURNAL_WINDOW_MS, RULES, highlightSeq, type ChronicleLookup } from './highlights';

const NAMES: Record<string, string> = { a1: 'Pip', a2: 'Brasa', a3: 'Mira', a4: 'Tobias' };
const look: ChronicleLookup = {
  agentName: (id) => NAMES[id],
  monsterKind: (id) => (id === 'ancient_colossus' ? 'world_boss' : id === 'the_hollow_regent' ? 'boss' : id === 'slime' ? 'normal' : undefined),
};

let seq = 100;
function ev(type: string, o: Partial<GameEvent> & { data?: Record<string, unknown> } = {}): GameEvent {
  const { data, ...rest } = o;
  return { id: String(++seq), ts: 1_000_000 + seq, type, visibility: 'public', roomId: 'village.square', payload: { ...data }, drama: 5, ...rest };
}

function one(e: GameEvent, d = new HighlightDetector(look)) {
  const out = d.detect(e);
  expect(out).toHaveLength(1);
  return out[0]!;
}
const none = (e: GameEvent, d = new HighlightDetector(look)) => expect(d.detect(e)).toEqual([]);

describe('highlight rules', () => {
  it('every rule has a test below and declares its keys', () => {
    expect(RULES.map((r) => r.type).sort()).toEqual(
      [
        'best_friends',
        'betrayal',
        'boss_kill',
        'bounty_claimed',
        'coup',
        'duel_upset',
        'embezzlement',
        'epic_drop',
        'fountain_jackpot',
        'guild_founded',
        'guild_hall_built',
        'hot_rumor',
        'journal_after',
        'level_20',
        'mayor_elected',
        'project_completed',
        'scam_reported',
        'statue_honor',
        'treasury_looted',
        'world_first',
      ].sort(),
    );
    expect(HIGHLIGHT_KEYS.every((k) => k.startsWith('highlight.'))).toBe(true);
  });

  it('world_first: a world-first achievement, not an ordinary one', () => {
    const h = one(ev('achievement', { actor: 'a1', drama: 8, data: { ach: 'wf_boss', world_first: true } }));
    expect(h).toMatchObject({ type: 'world_first', titleKey: 'highlight.world_first', params: { name: 'Pip', ach: '@ach:wf_boss' }, agents: ['Pip'], drama: 8, room: 'village.square' });
    expect(highlightSeq(h.id)).toBe(seq);
    none(ev('achievement', { actor: 'a1', data: { ach: 'first_blood', world_first: false } }));
  });

  it('fountain_jackpot: the winner and the gold, at the drama of the event', () => {
    const h = one(ev('fountain_jackpot', { actor: 'a2', drama: 9, data: { gold: 527 } }));
    expect(h).toMatchObject({ type: 'fountain_jackpot', titleKey: 'highlight.fountain_jackpot', params: { name: 'Brasa', gold: 527 }, agents: ['Brasa'], drama: 9, room: 'village.square' });
    // An ordinary wish is no highlight.
    none(ev('wish', { actor: 'a2', visibility: 'room', drama: 1, data: { text: 'gold please' } }));
  });

  it('epic_drop and legendary_drop: by rarity', () => {
    expect(one(ev('rare_drop', { actor: 'a2', data: { item: 'star_iron', rarity: 'epic', mon: 'golem' } }))).toMatchObject({ type: 'epic_drop', params: { name: 'Brasa', item: '@item:star_iron', mon: '@mon:golem' } });
    expect(one(ev('rare_drop', { actor: 'a2', data: { item: 'colossus_heart', rarity: 'legendary', mon: 'ancient_colossus' } })).titleKey).toBe('highlight.legendary_drop');
    none(ev('rare_drop', { actor: 'a2', data: { item: 'x', rarity: 'rare', mon: 'y' } }));
  });

  it('guild_founded', () => {
    expect(one(ev('guild_founded', { actor: 'a1', target: 'g1', data: { guild: 'g1', name: 'Iron Owls' } }))).toMatchObject({ params: { name: 'Pip', guild: 'Iron Owls' }, agents: ['Pip'] });
  });

  it('betrayal: traitor and victim', () => {
    expect(one(ev('betrayal', { actor: 'a1', target: 'a2', data: { traitor: 'Pip', victim: 'Brasa', party: ['Pip', 'Brasa'] } }))).toMatchObject({ params: { name: 'Pip', victim: 'Brasa' }, agents: ['Pip', 'Brasa'] });
  });

  it('scam_reported: the accused comes first', () => {
    expect(one(ev('scam_reported', { actor: 'a1', target: 'a2', data: { victim: 'Pip', accused: 'Brasa', value: 40 } }))).toMatchObject({ params: { name: 'Pip', accused: 'Brasa', value: 40 }, agents: ['Brasa', 'Pip'] });
  });

  it('treasury_looted: share as a percentage', () => {
    expect(one(ev('treasury_looted', { actor: 'a3', target: 'g1', data: { guild: 'Iron Owls', by: 'Mira', value: 900, share: 0.75 } }))).toMatchObject({ params: { name: 'Mira', guild: 'Iron Owls', value: 900, pct: 75 } });
  });

  it('coup: names from the payload, the reason kept for the text', () => {
    expect(one(ev('guild_coup', { actor: 'a3', target: 'g1', data: { guild: 'Iron Owls', old: 'Pip', new: 'Mira', reason: 'inactive' } }))).toMatchObject({ type: 'coup', params: { name: 'Mira', old: 'Pip', guild: 'Iron Owls', reason: 'inactive' }, agents: ['Mira', 'Pip'] });
  });

  it('mayor_elected: winner and votes, re-election told apart, no winner no highlight', () => {
    const votes = [{ id: 'a1', name: 'Pip', votes: 3 }, { id: 'a2', name: 'Brasa', votes: 1 }];
    const h = one(ev('election_result', { actor: 'a1', data: { m: { k: 'ev.election_won' }, n: 2, winner: 'Pip', votes, previous: 'Brasa' } }));
    expect(h).toMatchObject({ type: 'mayor_elected', params: { name: 'Pip', votes: 3, n: 2, old: 'Brasa' }, agents: ['Pip', 'Brasa'] });
    expect(one(ev('election_result', { actor: 'a1', data: { m: { k: 'ev.election_reelected' }, n: 3, winner: 'Pip', votes, previous: null } })).titleKey).toBe('highlight.mayor_reelected');
    none(ev('election_result', { data: { m: { k: 'ev.election_no_votes' }, n: 4, winner: null, votes } }));
  });

  it('embezzlement', () => {
    expect(one(ev('mayor_embezzle', { actor: 'a1', data: { gold: 50 } }))).toMatchObject({ params: { name: 'Pip', gold: 50 } });
  });

  it('project_completed: plaque names, or the village alone', () => {
    const plaque = [{ id: 'a2', name: 'Brasa', value: 300 }, { id: '@village', name: null, value: 100 }, { id: 'a1', name: 'Pip', value: 50 }];
    expect(one(ev('project_completed', { roomId: 'village.river_bank', data: { project: 'bridge', plaque } }))).toMatchObject({ params: { proj: '@proj:bridge', name: 'Brasa', by: 'agent' }, agents: ['Brasa', 'Pip'], room: 'village.river_bank' });
    expect(one(ev('project_completed', { data: { project: 'bridge', plaque: [{ id: '@village', name: null, value: 1 }] } })).params).toMatchObject({ name: '', by: 'village' });
  });

  it('bounty_claimed', () => {
    expect(one(ev('bounty_claimed', { actor: 'a4', target: 'a3', data: { hunter: 'Tobias', target: 'Mira', gold: 120 } }))).toMatchObject({ params: { name: 'Tobias', target: 'Mira', gold: 120 }, agents: ['Tobias', 'Mira'] });
  });

  it('duel_upset: only upsets', () => {
    expect(one(ev('duel', { actor: 'a1', target: 'a2', data: { winner: 'Pip', loser: 'Brasa', rounds: 7, upset: true } }))).toMatchObject({ params: { name: 'Pip', loser: 'Brasa', rounds: 7 } });
    none(ev('duel', { actor: 'a1', target: 'a2', data: { winner: 'Pip', loser: 'Brasa', rounds: 7, upset: false } }));
  });

  it('best_friends: only the best-friend level', () => {
    expect(one(ev('bond', { actor: 'a1', target: 'a2', data: { level: 'best_friend' } }))).toMatchObject({ params: { name: 'Pip', other: 'Brasa' }, agents: ['Pip', 'Brasa'] });
    none(ev('bond', { actor: 'a1', target: 'a2', visibility: 'private', data: { level: 'friend' } }));
  });

  it('hot_rumor: a rumor reaching the reply threshold, once, with its text as a quote', () => {
    const d = new HighlightDetector(look);
    none(ev('board_post', { actor: 'a3', lang: 'en', data: { post: 'b1', tag: 'rumor', text: 'The mayor hides gold in the well' } }), d);
    none(ev('board_post', { actor: 'a3', data: { post: 'b2', tag: 'trade', text: 'selling ore' } }), d);
    for (let i = 1; i < HOT_RUMOR_REPLIES; i++) none(ev('board_reply', { actor: 'a1', data: { post: 'b1', text: `reply ${i}` } }), d);
    for (let i = 0; i < HOT_RUMOR_REPLIES + 2; i++) none(ev('board_reply', { actor: 'a1', data: { post: 'b2', text: 'not a rumor' } }), d);
    const h = one(ev('board_reply', { actor: 'a2', data: { post: 'b1', text: 'no way' } }), d);
    expect(h).toMatchObject({ type: 'hot_rumor', params: { name: 'Mira', n: HOT_RUMOR_REPLIES }, quote: { text: 'The mayor hides gold in the well', lang: 'en' } });
    none(ev('board_reply', { actor: 'a2', data: { post: 'b1', text: 'again' } }), d);
  });

  it('journal_after: a journal entry soon after a highlight about its author, linked to it', () => {
    const d = new HighlightDetector(look);
    const betrayal = one(ev('betrayal', { actor: 'a1', target: 'a2', data: { traitor: 'Pip', victim: 'Brasa' } }), d);
    none(ev('journal', { actor: 'a3', data: { text: 'quiet day' } }), d);
    const h = one(ev('journal', { actor: 'a2', lang: 'pt-BR', data: { text: 'Pip me traiu.' } }), d);
    expect(h).toMatchObject({ type: 'journal_after', params: { name: 'Brasa', about: 'betrayal' }, ref: betrayal.id, quote: { text: 'Pip me traiu.', lang: 'pt-BR' } });
    // Once per moment, and only within the window.
    none(ev('journal', { actor: 'a2', data: { text: 'still sad' } }), d);
    none(ev('journal', { actor: 'a1', ts: betrayal.ts + JOURNAL_WINDOW_MS + 1, data: { text: 'no regrets' } }), d);
  });

  it('boss_kill and world_boss_kill: by monster kind, with everyone credited', () => {
    expect(one(ev('kill', { actor: 'a1', target: 'm1', data: { mon: 'the_hollow_regent', boss: true, by: ['Pip', 'Mira'] } }))).toMatchObject({ type: 'boss_kill', params: { name: 'Pip', mon: '@mon:the_hollow_regent', n: 2 }, agents: ['Pip', 'Mira'] });
    expect(one(ev('kill', { actor: 'a2', target: 'm2', data: { mon: 'ancient_colossus', boss: true, by: ['Brasa', 'Pip', 'Mira'] } }))).toMatchObject({ type: 'world_boss_kill', params: { n: 3 } });
    none(ev('kill', { actor: 'a1', target: 'm3', visibility: 'room', data: { mon: 'slime', boss: false, by: ['Pip'] } }));
  });

  it('level_20: only the top level', () => {
    expect(one(ev('level_up', { actor: 'a4', data: { level: 20 } }))).toMatchObject({ params: { name: 'Tobias', level: 20 } });
    none(ev('level_up', { actor: 'a4', data: { level: 19 } }));
  });

  it('statue_honor', () => {
    expect(one(ev('statue_honor', { actor: 'a2', data: { name: 'Brasa', value: 900 } }))).toMatchObject({ params: { name: 'Brasa', value: 900 } });
  });

  it('guild_hall_built', () => {
    expect(one(ev('guild_hall_built', { actor: 'a1', target: 'g1', roomId: 'village.plot_se', data: { guild: 'g1', name: 'Iron Owls', plot: 'village.plot_se' } }))).toMatchObject({ params: { name: 'Pip', guild: 'Iron Owls', room: '@room:village.plot_se' } });
  });

  it('events no rule knows produce nothing', () => {
    none(ev('say', { actor: 'a1', data: { text: 'hello' } }));
    none(ev('move', { actor: 'a1' }));
  });
});
