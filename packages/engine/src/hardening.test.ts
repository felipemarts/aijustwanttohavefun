import { describe, expect, it } from 'vitest';
import { addGold, addItem, removeItem, takeGold } from './agent';
import { applyParsed, HANDLERS } from './apply';
import { BALANCE } from './balance';
import { postKey } from './board';
import { settle, worldBytes } from './fuzzkit';
import { checkInvariants } from './invariants';
import { creditTreasury, debitTreasury, stockAdd, stockTake } from './ledger';
import { deactivateAgent, reactivateAgent } from './register';
import { newRun } from './run';
import { exportAll, exportDirty, restoreWorld, type Snapshot } from './snapshot';
import { dataOf, errKey, makeKit } from './testkit';

const MARKET = 'village.market';
const SQUARE = 'village.square';

describe('applyAction', () => {
  it('turns an unexpected exception into an INTERNAL refusal handed back for logging, without throwing', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const original = HANDLERS.inventory;
    const boom = new RangeError('boom');
    HANDLERS.inventory = () => {
      throw boom;
    };
    try {
      const r = k.act(a, 'inventory');
      expect(r.result).toMatchObject({ ok: false, error: { code: 'INTERNAL', msg: { k: 'err.internal' }, hint: { k: 'hint.internal' } } });
      expect(r.internal).toBe(boom);
      expect(r.events).toEqual([]);
    } finally {
      HANDLERS.inventory = original;
    }
    // Ordinary refusals carry no `internal`.
    const r = k.act(a, 'move', { dir: 'nowhere' });
    expect(r.result.ok).toBe(false);
    expect(r.internal).toBeUndefined();
  });

  it('the boundary still refuses prototype names; past it, the engine refuses them on its own', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: MARKET });
    expect(errKey(k.act(a, 'market_buy', { order: '__proto__' }))).toBe('err.invalid_params');
    settle(k, a);
    const before = worldBytes(k.s);
    for (const [action, params] of [
      ['market_buy', { order: '__proto__' }],
      ['market_buy', { order: 'constructor', qty: 1 }],
      ['move', { dir: '__proto__' }],
      ['move', { dir: 'constructor' }],
      ['take', { item: '__proto__' }],
      ['give', { to: 'Pip', items: { ['__proto__']: 1 } }],
    ] as const) {
      const r = applyParsed(k.s, a, action, params, k.ctx());
      expect(r.result.ok, action).toBe(false);
      expect(r.internal, action).toBeUndefined();
    }
    expect(worldBytes(k.s)).toEqual(before);
    expect(a.gold).toBe(BALANCE.startGold);
    expect(a.room).toBe(MARKET);
  });
});

describe('ledger', () => {
  it('checks amounts and balances before anything moves', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const run = newRun(k.s, k.now, k.rng, a);
    const gold = a.gold;
    for (const bad of [NaN, Infinity, -1, 1.5, 2 ** 53]) {
      expect(() => addGold(run, a, bad)).toThrow(/ledger/);
      expect(() => takeGold(a, bad)).toThrow(/ledger/);
      expect(() => addItem(a, 'iron_ore', bad)).toThrow(/ledger/);
    }
    expect(() => takeGold(a, gold + 1)).toThrow(/ledger/);
    expect(() => removeItem(a, 'iron_ore', 1)).toThrow(/ledger/);
    expect(a.gold).toBe(gold);
    expect(a.inv.iron_ore).toBeUndefined();
    // A NaN balance never covers anything.
    const g = { treasury: NaN };
    expect(() => debitTreasury(g, 1, 'test')).toThrow(/ledger/);
    expect(() => creditTreasury(g, 1, 'test')).toThrow(/ledger/);
    const stock: Record<string, number> = {};
    expect(() => stockAdd(stock, '__proto__', 1, 'test')).toThrow(/ledger/);
    expect(() => stockAdd(stock, 'constructor', 1, 'test')).toThrow(/ledger/);
    expect(() => stockTake(stock, 'constructor', 1, 'test')).toThrow(/ledger/);
    expect(Object.getPrototypeOf(stock)).toBe(Object.prototype);
    expect(stock).toEqual({});
  });

  it('a NaN balance fails closed: no purchase, no offer, no transfer', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: MARKET });
    const b = k.add('Bob', 'warrior', { room: MARKET });
    addItem(b, 'iron_ore', 1);
    k.ok(b, 'market_sell', { item: 'iron_ore', qty: 1, price: 5 });
    a.gold = NaN;
    const order = Object.keys(k.s.market.orders)[0]!;
    expect(errKey(k.act(a, 'market_buy', { order }))).toBe('err.no_gold');
    expect(errKey(k.act(a, 'give', { to: 'Bob', gold: 10 }))).toBe('err.goods_missing');
    expect(errKey(k.act(a, 'trade_offer', { to: 'Bob', give: { gold: 10 }, want: {} }))).toBe('err.trade_missing');
    expect(b.gold).toBe(BALANCE.startGold);
    expect(checkInvariants(k.s, k.now)).toContain(`agent ${a.id} (Pip): gold NaN is not a non-negative integer`);
  });
});

describe('invariants', () => {
  it('flag non-integer or non-finite amounts anywhere, records with a replaced prototype, and polluted keys', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.guild_hall' });
    a.gold = 2000;
    k.ok(a, 'guild_create', { name: 'Iron Wolves' });
    const g = k.s.guilds.get(a.guild!)!;
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    a.inv.iron_ore = 1.5;
    a.stats.kills = Infinity;
    g.treasury = NaN;
    g.vault.iron_ore = -2;
    k.s.village.treasury = 0.1;
    Object.setPrototypeOf(a.cooldowns, { evil: 1 });
    Object.defineProperty(a.quests, 'constructor', { value: { steps: [], at: 0 }, enumerable: true, writable: true, configurable: true });
    const bad = checkInvariants(k.s, k.now).join('\n');
    expect(bad).toContain('inv: iron_ore = 1.5');
    expect(bad).toContain('stats: kills = Infinity');
    expect(bad).toContain('treasury NaN');
    expect(bad).toContain('vault: iron_ore = -2');
    expect(bad).toContain('village treasury 0.1');
    expect(bad).toContain('cooldowns: prototype replaced');
    expect(bad).toContain('quests: reserved key "constructor"');
  });
});

describe('notice board storage', () => {
  it('saves one entry per post, rewrites only the post that changed, and drops trimmed posts from the store', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior');
    exportDirty(k.s);
    const first = dataOf(k.ok(a, 'board_post', { text: 'Selling ore', tag: 'trade' })).post as string;
    const snap = exportDirty(k.s);
    expect(snap.world.map((e) => e.key).sort()).toEqual(['meta', postKey(first)]);
    k.ok(b, 'board_reply', { post: first, text: 'how much?' });
    expect(exportDirty(k.s).world.map((e) => e.key)).toEqual([postKey(first)]);
    // Over the post limit, the oldest goes and its entry is exported as null.
    for (let i = 0; i < BALANCE.board.maxPosts; i++) {
      k.advance(BALANCE.board.postCooldownMs);
      k.ok(a, 'board_post', { text: `post ${i}`, tag: 'general' });
    }
    const after = exportDirty(k.s);
    expect(after.world.find((e) => e.key === postKey(first))).toEqual({ key: postKey(first), data: null });
    expect(k.s.board).toHaveLength(BALANCE.board.maxPosts);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('keeps the text it holds in memory under the byte cap, oldest posts first', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const B = BALANCE.board;
    const long = ' the quick brown fox jumps over the lazy dog'.repeat(15);
    const per = 2 * (long.length + 1);
    const fit = Math.floor(B.maxTextBytes / per);
    // Shrink the cap for the test (read back from BALANCE everywhere).
    const cap = B.maxTextBytes;
    (B as { maxTextBytes: number }).maxTextBytes = per * 3;
    try {
      for (let i = 0; i < 5; i++) {
        k.advance(B.postCooldownMs);
        k.ok(a, 'board_post', { text: `${i}${long}`, tag: 'general' });
      }
      expect(k.s.board.map((p) => p.text[0])).toEqual(['2', '3', '4']);
      expect(k.s.boardBytes).toBeLessThanOrEqual(B.maxTextBytes);
      expect(checkInvariants(k.s, k.now)).toEqual([]);
    } finally {
      (B as { maxTextBytes: number }).maxTextBytes = cap;
    }
    expect(fit).toBeGreaterThan(B.maxPosts);
  });

  it('loads the legacy whole-board entry of older snapshots and migrates it to entries per post', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.ok(a, 'board_post', { text: 'old post', tag: 'rumor' });
    k.advance(BALANCE.board.postCooldownMs);
    k.ok(a, 'board_post', { text: 'newer post', tag: 'general' });
    const snap = exportAll(k.s);
    const posts = snap.world.filter((e) => e.key.startsWith('post:')).map((e) => e.data);
    const legacy: Snapshot = { agents: snap.agents, world: [...snap.world.filter((e) => !e.key.startsWith('post:')), { key: 'board', data: posts }] };
    const restored = restoreWorld(k.c, JSON.parse(JSON.stringify(legacy)) as Snapshot, k.now);
    expect(restored.board.map((p) => p.text)).toEqual(['old post', 'newer post']);
    const migrated = exportDirty(restored);
    expect(migrated.world.find((e) => e.key === 'board')).toEqual({ key: 'board', data: null });
    expect(migrated.world.filter((e) => e.key.startsWith('post:')).map((e) => e.key)).toEqual(restored.board.map((p) => postKey(p.id)));
    expect(checkInvariants(restored, k.now)).toEqual([]);
    // And a snapshot written now restores to the same board.
    expect(restoreWorld(k.c, JSON.parse(JSON.stringify(exportAll(restored))) as Snapshot, k.now).board).toEqual(restored.board);
  });
});

describe('bounded state', () => {
  it('cancelled and accepted trades leave nothing on the timer heap; expired ones are swept', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.add('Bob', 'warrior');
    const heap = k.s.timers.size;
    for (let i = 0; i < 50; i++) {
      const t = dataOf(k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} })).trade as string;
      k.ok(a, 'trade_cancel', { trade: t });
    }
    expect(k.s.timers.size).toBeLessThanOrEqual(heap);
    expect(k.s.trades.size).toBe(0);
    k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} });
    expect(k.s.trades.size).toBe(1);
    k.advance(BALANCE.trade.ttlMs);
    expect(k.s.trades.size).toBe(0);
    expect(k.s.tradesOf.size).toBe(0);
  });

  it('drops the trade timers of older snapshots on restore', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.add('Bob', 'warrior');
    const t = dataOf(k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} })).trade as string;
    const snap = exportAll(k.s);
    const timers = snap.world.find((e) => e.key === 'timers')!;
    timers.data = [...(timers.data as unknown[]), { at: k.now + BALANCE.trade.ttlMs, kind: 'trade', id: t }];
    const restored = restoreWorld(k.c, JSON.parse(JSON.stringify(snap)) as Snapshot, k.now);
    expect(restored.timers.toJSON().some((x) => x.kind === 'trade')).toBe(false);
    expect(restored.trades.has(t)).toBe(true);
  });

  it('friend requests lapse: they stop counting, blocking and being accepted', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior');
    k.ok(a, 'friend_request', { agent: 'Bob' });
    expect(Object.keys(b.friendReqs)).toEqual([a.id]);
    k.advance(BALANCE.social.friendRequestMs);
    expect(errKey(k.act(b, 'friend_accept', { agent: 'Pip' }))).toBe('err.no_friend_request');
    // A lapsed request does not block a new one, which replaces it.
    k.ok(a, 'friend_request', { agent: 'Bob' });
    expect(b.friendReqs[a.id]).toBe(k.now);
    k.ok(b, 'friend_accept', { agent: 'Pip' });
    expect(a.friends).toEqual([b.id]);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('cancels the market orders of a retired or banned agent, items back in its bags; a lifted ban spills what no longer fits', () => {
    const k = makeKit();
    const s = k.add('Seller', 'warrior', { room: MARKET });
    const buyer = k.add('Buyer', 'mage', { room: MARKET });
    addItem(s, 'iron_ore', 10);
    k.ok(s, 'market_sell', { item: 'iron_ore', qty: 10, price: 3 });
    expect(s.inv.iron_ore).toBeUndefined();
    deactivateAgent(k.s, s.id, 'banned');
    expect(Object.keys(k.s.market.orders)).toEqual([]);
    expect(k.s.ordersOf.has(s.id)).toBe(false);
    expect(s.inv.iron_ore).toBe(10);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    expect(errKey(k.act(buyer, 'market_list', {}))).toBeNull();
    // Its bags filled up while it was away: back in play, what does not fit is set down where it stands.
    const sword = [...k.c.items.values()].find((x) => x.type === 'weapon')!.id;
    for (let i = 0; i < BALANCE.inventory.slots + 5; i++) stockAdd(s.inv, sword, 1, 'test');
    reactivateAgent(k.s, s.id);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    expect(k.s.rooms.get(s.room)!.ground[sword]).toBeGreaterThan(0);
  });

  it('a restore cancels the orders of sellers already inactive in an older snapshot', () => {
    const k = makeKit();
    const s = k.add('Seller', 'warrior', { room: MARKET });
    addItem(s, 'iron_ore', 4);
    k.ok(s, 'market_sell', { item: 'iron_ore', qty: 4, price: 3 });
    s.status = 'retired';
    const restored = restoreWorld(k.c, JSON.parse(JSON.stringify(exportAll(k.s))) as Snapshot, k.now);
    expect(Object.keys(restored.market.orders)).toEqual([]);
    expect(restored.agents.get(s.id)!.inv.iron_ore).toBe(4);
    expect(exportDirty(restored).agents.map((x) => x.id)).toEqual([s.id]);
    expect(checkInvariants(restored, k.now)).toEqual([]);
  });

  it('chat checks its cooldown before cleaning the text, and a refused message changes nothing', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: SQUARE });
    k.step = 0;
    k.ok(a, 'say', { text: 'hello' });
    // Within the cooldown, the cooldown answers first, whatever the text.
    expect(errKey(k.act(a, 'say', { text: '\u200b' }))).toBe('err.chat_cooldown');
    k.advance(BALANCE.chat.sayCooldownMs);
    settle(k, a);
    const before = worldBytes(k.s);
    expect(errKey(k.act(a, 'say', { text: '\u200b' }))).toBe('err.empty_text');
    expect(worldBytes(k.s)).toEqual(before);
    // The refusal did not start the cooldown.
    expect(k.act(a, 'say', { text: 'again' }).result.ok).toBe(true);
  });
});
