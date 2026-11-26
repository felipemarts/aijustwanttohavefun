import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { HOUR, errKey, keys, makeKit, narr, type Kit } from './testkit';
import type { AgentState, ApplyResult } from './types';

function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  expect(errKey(k.act(a, action, params)), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
}

const dataOf = (r: ApplyResult) => (r.result.ok ? r.result.data! : {});

describe('duels', () => {
  function yard(k: Kit) {
    const a = k.add('Pip', 'warrior', { room: 'village.training_yard', level: 3 });
    const b = k.add('Bob', 'mage', { room: 'village.training_yard', level: 3 });
    return { a, b };
  }

  it('invite and accept: fought at once, the loser stands on 1 HP, nothing changes hands', () => {
    const k = makeKit();
    const { a, b } = yard(k);
    const gold = [a.gold, b.gold];
    const inv = JSON.stringify([a.inv, b.inv]);
    expect(narr(k.ok(a, 'duel_invite', { agent: 'Bob' }), 'n.duel_invite')).toEqual({ name: 'Bob', minutes: 5 });
    expect(b.duelInvites[a.id]).toBe(k.now + BALANCE.duel.inviteMs);
    const r = k.ok(b, 'duel_accept', { agent: 'Pip' });
    const ev = r.events.find((e) => e.type === 'duel')!;
    expect(ev.visibility).toBe('public');
    const { winner, loser, rounds, upset } = ev.payload as { winner: string; loser: string; rounds: number; upset: boolean };
    expect([winner, loser].sort()).toEqual(['Bob', 'Pip']);
    expect(rounds).toBeGreaterThan(0);
    expect(upset).toBe(false);
    const [w, l] = winner === 'Pip' ? [a, b] : [b, a];
    expect(l.hp).toBe(1);
    expect(w.hp).toBeGreaterThanOrEqual(1);
    expect(a.fallen ?? b.fallen).toBeNull();
    expect(w.stats.duels_won).toBe(1);
    expect(l.stats.duels_won).toBeUndefined();
    expect([a.gold, b.gold]).toEqual(gold);
    expect(JSON.stringify([a.inv, b.inv])).toBe(inv);
    expect(keys(r)).toContain(w === b ? 'n.duel_won' : 'n.duel_lost');
    expect(b.duelInvites).toEqual({});
  });

  it('an underdog win is an upset', () => {
    const k = makeKit();
    const low = k.add('Low', 'warrior', { room: 'village.training_yard', level: 2 });
    const high = k.add('High', 'mage', { room: 'village.training_yard', level: 5 });
    // The challenger fights from full health, the favourite from almost nothing.
    k.ok(low, 'duel_invite', { agent: 'High' });
    high.hp = 1;
    const ev = k.ok(high, 'duel_accept', { agent: 'Low' }).events.find((e) => e.type === 'duel')!;
    expect(ev.payload).toMatchObject({ winner: 'Low', loser: 'High', upset: true });
    expect(ev.drama).toBe(6);
  });

  it('errors', () => {
    const k = makeKit();
    const { a, b } = yard(k);
    const out = k.add('Out', 'rogue');
    k.add('Far', 'rogue', { room: 'village.square' });
    refuse(k, out, 'duel_invite', { agent: 'Far' }, 'duel_place');
    refuse(k, a, 'duel_invite', { agent: 'Out' }, 'agent_not_here');
    refuse(k, a, 'duel_invite', { agent: 'Pip' }, 'not_yourself_social');
    refuse(k, b, 'duel_accept', { agent: 'Pip' }, 'no_duel_invite');
    k.ok(a, 'duel_invite', { agent: 'Bob' });
    k.advance(BALANCE.duel.inviteMs);
    refuse(k, b, 'duel_accept', { agent: 'Pip' }, 'no_duel_invite');
    b.combat = { mon: 'm1', until: k.now + HOUR };
    refuse(k, a, 'duel_invite', { agent: 'Bob' }, 'duel_busy');
    b.combat = null;
    b.hp = 0;
    b.fallen = { at: k.now, until: k.now + HOUR, by: 'x' };
    refuse(k, a, 'duel_invite', { agent: 'Bob' }, 'duel_fallen');
    b.fallen = null;
    b.hp = 10;
    for (let i = 0; i < BALANCE.duel.maxInvites; i++) b.duelInvites[`x${i}`] = k.now + HOUR;
    refuse(k, a, 'duel_invite', { agent: 'Bob' }, 'duel_invites_full');
  });
});

describe('notice board', () => {
  it('post, reply and read: public events with the text, compact rows, tags, stats', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.tavern' });
    const b = k.add('Bob', 'mage', { room: 'village.square' });
    a.quests.t13_notice_board = { steps: [0], at: k.now };
    const long = 'The mayor hides gold under the old oak. '.repeat(4);
    const r = k.ok(a, 'board_post', { text: long, tag: 'rumor' });
    const post = dataOf(r).post as string;
    const ev = r.events.find((e) => e.type === 'board_post')!;
    expect(ev).toMatchObject({ visibility: 'public', drama: 3, payload: { post, tag: 'rumor', text: long.trim() } });
    expect(a.stats.board_posts).toBe(1);
    expect(a.stats.rumors).toBe(1);
    expect(a.quests.t13_notice_board!.steps).toEqual([1]);
    const rep = k.ok(b, 'board_reply', { post, text: 'nonsense' });
    expect(rep.events[0]).toMatchObject({ type: 'board_reply', target: a.id, visibility: 'public', payload: { post, text: 'nonsense' } });
    k.ok(b, 'board_post', { text: 'LFG wolves', tag: 'lfg' });
    const list = dataOf(k.ok(b, 'board_read', {})).posts as { id: string; by: string; tag: string; untrusted_text: string; re: number }[];
    expect(list.map((x) => [x.by, x.tag, x.re])).toEqual([
      ['Bob', 'lfg', 0],
      ['Pip', 'rumor', 1],
    ]);
    expect([...list[1]!.untrusted_text]).toHaveLength(BALANCE.board.preview);
    expect((dataOf(k.ok(b, 'board_read', { tag: 'rumor' })).posts as unknown[]).length).toBe(1);
    const one = dataOf(k.ok(b, 'board_read', { post })).post;
    expect(one).toEqual({ id: post, by: 'Pip', tag: 'rumor', untrusted_text: long.trim(), replies: [{ by: 'Bob', untrusted_text: 'nonsense' }] });
  });

  it('keeps the latest posts only', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    for (let i = 0; i < BALANCE.board.maxPosts + 3; i++) {
      k.ok(a, 'board_post', { text: `post ${i}`, tag: 'general' });
      k.advance(BALANCE.board.postCooldownMs);
    }
    expect(k.s.board).toHaveLength(BALANCE.board.maxPosts);
    expect(k.s.board[0]!.text).toBe('post 3');
  });

  it('errors', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const away = k.add('Away', 'mage', { room: 'village.market' });
    refuse(k, away, 'board_post', { text: 'hi', tag: 'general' }, 'board_only');
    refuse(k, away, 'board_read', {}, 'board_only');
    refuse(k, away, 'board_reply', { post: 'b1', text: 'hi' }, 'board_only');
    refuse(k, a, 'board_post', { text: '​ ', tag: 'general' }, 'empty_text');
    const post = dataOf(k.ok(a, 'board_post', { text: 'first', tag: 'general' })).post as string;
    refuse(k, a, 'board_post', { text: 'second', tag: 'general' }, 'board_cooldown');
    refuse(k, a, 'board_reply', { post: 'b99', text: 'hi' }, 'post_unknown');
    refuse(k, a, 'board_read', { post: 'b99' }, 'post_unknown');
    k.s.board[0]!.replies = Array.from({ length: BALANCE.board.maxReplies }, () => ({ by: a.id, text: 'x', at: k.now }));
    refuse(k, a, 'board_reply', { post, text: 'one more' }, 'board_replies_full');
    const wild = k.add('Wild', 'rogue', { claimed: false });
    expect(k.err(wild, 'board_post', { text: 'hi', tag: 'general' })).toBe('UNCLAIMED_LIMIT');
    k.ok(wild, 'board_read', {});
  });
});

describe('journal', () => {
  it('three public entries per real day, multiline, with stat and quest step', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.quests.t14_dear_diary = { steps: [0], at: k.now };
    const r = k.ok(a, 'journal', { text: 'Day one.\nI met a slime.\n\n\n\nIt won.' });
    expect(narr(r, 'n.journal')).toEqual({ left: 2 });
    expect(r.events[0]).toMatchObject({ type: 'journal', visibility: 'public', payload: { text: 'Day one.\nI met a slime.\n\nIt won.' } });
    expect(a.stats.journal_entries).toBe(1);
    expect(a.quests.t14_dear_diary!.steps).toEqual([1]);
    k.ok(a, 'journal', { text: 'two' });
    k.ok(a, 'journal', { text: 'three' });
    refuse(k, a, 'journal', { text: 'four' }, 'journal_limit');
    k.advance(24 * HOUR);
    k.ok(a, 'journal', { text: 'a new day' });
    refuse(k, a, 'journal', { text: '​' }, 'empty_text');
    const long = k.ok(a, 'journal', { text: 'x'.repeat(3000) });
    expect([...(long.events[0]!.payload.text as string)]).toHaveLength(1000);
  });
});
