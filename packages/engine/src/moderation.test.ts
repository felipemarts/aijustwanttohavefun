import { describe, expect, it } from 'vitest';
import { removeBoardPost } from './actions/board';
import { checkInvariants } from './invariants';
import { deactivateAgent, nameAvailable, reactivateAgent } from './register';
import { exportAll, restoreWorld, type Snapshot } from './snapshot';
import { dataOf, HOUR, makeKit, type Kit } from './testkit';

const sound = (k: Kit) => expect(checkInvariants(k.s, k.now)).toEqual([]);
const persist = (k: Kit) => JSON.parse(JSON.stringify(exportAll(k.s))) as Snapshot;

describe('reactivateAgent', () => {
  it('lifts a ban: active again in its room, in the indexes, name still reserved', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.tavern' });
    const b = k.add('Bob', 'mage', { room: 'village.tavern' });
    k.ok(a, 'party_invite', { agent: 'Bob' });
    k.ok(b, 'party_accept', { agent: 'Pip' });
    deactivateAgent(k.s, a.id, 'banned');
    sound(k);
    expect(k.s.roomAgents.get('village.tavern')!.has(a.id)).toBe(false);
    expect(k.s.lookHashes.has(a.lookHash)).toBe(false);
    expect(a.party).toBeNull();
    expect(nameAvailable(k.s, 'Pip').ok).toBe(false);

    k.s.dirty.clear();
    expect(reactivateAgent(k.s, a.id)).toBe(true);
    sound(k);
    expect(a.status).toBe('active');
    expect(a.room).toBe('village.tavern');
    expect(k.s.roomAgents.get('village.tavern')!.has(a.id)).toBe(true);
    expect(k.s.lookHashes.get(a.lookHash)).toBe(1);
    expect(k.s.byName.get(a.norm)).toBe(a.id);
    expect(nameAvailable(k.s, 'Pip').ok).toBe(false);
    expect(k.s.dirty.has(`agent:${a.id}`)).toBe(true);
    // The party it left is not restored; it can play again at once.
    expect(a.party).toBeNull();
    k.ok(a, 'say', { text: 'I am back.' });
    sound(k);
  });

  it('ban, snapshot, restore, unban: the restored world matches the live one', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.add('Bob', 'mage');
    deactivateAgent(k.s, a.id, 'banned');
    const restored = restoreWorld(k.c, persist(k), k.now);
    expect(restored.lookHashes).toEqual(k.s.lookHashes);
    expect(restored.roomAgents).toEqual(k.s.roomAgents);
    expect(reactivateAgent(restored, a.id)).toBe(true);
    expect(reactivateAgent(k.s, a.id)).toBe(true);
    expect(restored.lookHashes).toEqual(k.s.lookHashes);
    expect(restored.roomAgents).toEqual(k.s.roomAgents);
    expect(checkInvariants(restored, k.now)).toEqual([]);
    sound(k);
  });

  it('is a no-op for unknown, active and retired agents', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const r = k.add('Old', 'rogue');
    deactivateAgent(k.s, r.id, 'retired');
    k.s.dirty.clear();
    expect(reactivateAgent(k.s, 'a-nobody')).toBe(false);
    expect(reactivateAgent(k.s, a.id)).toBe(false);
    expect(reactivateAgent(k.s, r.id)).toBe(false);
    expect(r.status).toBe('retired');
    expect(k.s.roomAgents.get(r.room)!.has(r.id)).toBe(false);
    expect(k.s.lookHashes.get(a.lookHash)).toBe(1);
    expect(k.s.dirty.size).toBe(0);
    sound(k);
  });

  it('banning twice and reactivating once counts the look once', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    deactivateAgent(k.s, a.id, 'banned');
    deactivateAgent(k.s, a.id, 'banned');
    sound(k);
    expect(reactivateAgent(k.s, a.id)).toBe(true);
    expect(reactivateAgent(k.s, a.id)).toBe(false);
    expect(k.s.lookHashes.get(a.lookHash)).toBe(1);
    sound(k);
  });
});

describe('removeBoardPost', () => {
  function board(k: Kit) {
    const a = k.add('Pip', 'warrior', { room: 'village.tavern' });
    const b = k.add('Bob', 'mage', { room: 'village.tavern' });
    const first = dataOf(k.ok(a, 'board_post', { text: 'Selling a cursed sword', tag: 'trade' })).post as string;
    const second = dataOf(k.ok(b, 'board_post', { text: 'LFG wolves', tag: 'lfg' })).post as string;
    k.ok(b, 'board_reply', { post: first, text: 'how cursed?' });
    k.ok(a, 'board_reply', { post: first, text: 'very' });
    k.advance(HOUR);
    k.ok(b, 'board_reply', { post: first, text: 'pass' });
    k.advance(HOUR);
    return { a, b, first, second };
  }

  it('removes a whole post with its replies', () => {
    const k = makeKit();
    const { a, first, second } = board(k);
    const seq = k.s.meta.postSeq;
    k.s.dirty.clear();
    const removed = removeBoardPost(k.s, first);
    expect(removed?.post).toMatchObject({ id: first, by: a.id, text: 'Selling a cursed sword' });
    expect(removed?.post.replies).toHaveLength(3);
    expect(removed?.reply).toBeUndefined();
    expect(k.s.board.map((p) => p.id)).toEqual([second]);
    expect(k.s.dirty.has('board')).toBe(true);
    expect(k.s.meta.postSeq).toBe(seq);
    expect(a.stats.board_posts).toBe(1);
    sound(k);
    // Gone for readers, and ids are not reused.
    expect(k.err(a, 'board_read', { post: first })).toBe('TARGET_NOT_FOUND');
    k.advance(HOUR);
    const next = dataOf(k.ok(a, 'board_post', { text: 'New post', tag: 'trade' })).post as string;
    expect(next).not.toBe(first);
    sound(k);
  });

  it('removes one reply; the later ones move up', () => {
    const k = makeKit();
    const { b, first } = board(k);
    k.s.dirty.clear();
    const removed = removeBoardPost(k.s, first, 1);
    expect(removed?.reply).toMatchObject({ text: 'very' });
    expect(removed?.post.id).toBe(first);
    const post = k.s.board.find((p) => p.id === first)!;
    expect(post.replies.map((r) => r.text)).toEqual(['how cursed?', 'pass']);
    expect(k.s.dirty.has('board')).toBe(true);
    sound(k);
    // A freed reply slot can be used again.
    k.ok(b, 'board_reply', { post: first, text: 'still there?' });
    expect(post.replies).toHaveLength(3);
    sound(k);
  });

  it('returns null and changes nothing for unknown posts or replies', () => {
    const k = makeKit();
    const { first } = board(k);
    const before = JSON.stringify(k.s.board);
    k.s.dirty.clear();
    for (const [id, i] of [['b999', undefined], [first, 3], [first, -1], [first, 0.5], ['b999', 0]] as const) {
      expect(removeBoardPost(k.s, id, i), `${id} ${i}`).toBeNull();
    }
    expect(JSON.stringify(k.s.board)).toBe(before);
    expect(k.s.dirty.has('board')).toBe(false);
    sound(k);
  });
});
