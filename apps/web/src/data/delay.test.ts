import { describe, expect, it } from 'vitest';
import { BROADCAST_DELAY, DelayLine } from './delay';
import type { DataSource, SourceHandlers } from './source';
import { LiveStore } from './store';

describe('DelayLine', () => {
  it('passes messages straight through while inactive', () => {
    const d = new DelayLine<string>();
    expect(d.push('a', 0)).toEqual(['a']);
    expect(d.lag(0)).toBe(0);
  });

  it('builds the lag gradually: a message arriving a ms after the start waits min(30 s, a/2)', () => {
    const d = new DelayLine<string>();
    d.start(0);
    expect(d.push('t0', 0)).toEqual(['t0']); // nothing held, no lag yet
    expect(d.push('t10', 10_000)).toEqual([]); // held 5 s
    expect(d.push('t60', 60_000)).toEqual([]); // held 30 s
    expect(d.push('t100', 100_000)).toEqual([]); // held 30 s (the cap)
    expect(d.release(14_999)).toEqual([]);
    expect(d.release(15_000)).toEqual(['t10']);
    expect(d.release(89_999)).toEqual([]);
    expect(d.release(90_000)).toEqual(['t60']);
    expect(d.release(130_000)).toEqual(['t100']);
    // the screen's lag: a third of the elapsed time during the ramp, then the full delay
    expect(d.lag(30_000)).toBeCloseTo(10_000);
    expect(d.lag(90_000)).toBe(BROADCAST_DELAY.maxMs);
    expect(d.lag(500_000)).toBe(BROADCAST_DELAY.maxMs);
  });

  it('keeps the order of arrival, whatever the release cadence', () => {
    const d = new DelayLine<number>();
    d.start(0);
    const out: number[] = [];
    for (let t = 0; t <= 120_000; t += 250) {
      out.push(...d.push(t, t));
      if (t % 1000 === 0) out.push(...d.release(t));
    }
    out.push(...d.release(1e9));
    expect(out).toEqual([...out].sort((a, b) => a - b));
    expect(out.length).toBe(481);
  });

  it('stop applies everything held at once; restart does too and builds the lag from zero again', () => {
    const d = new DelayLine<string>();
    d.start(0);
    d.push('a', 20_000);
    d.push('b', 21_000);
    expect(d.stop()).toEqual(['a', 'b']);
    expect(d.active).toBe(false);
    expect(d.push('c', 22_000)).toEqual(['c']);
    d.start(30_000);
    d.push('d', 50_000);
    expect(d.restart(51_000)).toEqual(['d']);
    expect(d.lag(51_000)).toBe(0);
    expect(d.push('e', 51_000)).toEqual(['e']);
  });
});

class FakeSource implements DataSource {
  readonly kind = 'mock' as const;
  handlers: SourceHandlers | null = null;
  topics: readonly string[] = [];
  connect(h: SourceHandlers) {
    this.handlers = h;
  }
  setTopics(t: readonly string[]) {
    this.topics = t;
  }
  close() {}
  getJson() {
    return Promise.resolve(null);
  }
  spriteImage() {
    return Promise.resolve(null);
  }
  npcSpriteImage() {
    return Promise.resolve(null);
  }
  send(msg: unknown) {
    this.handlers!.message(msg);
  }
}

const room = (id: string, x: number) => ({ id, zone: 'village', rect: [x, 0, 10, 10], flags: [], exits: {} });
const pos = (n: string, r: string) => ({ n, r, l: 1, c: 'warrior', s: 'abcdef', t: null });

function setup() {
  let clock = 0;
  const store = new LiveStore(() => clock, { autoPump: false });
  const src = new FakeSource();
  store.start(src);
  const serverAt = (t: number) => 1_000_000 + t;
  src.send({ t: 'hello', now: serverAt(0), day: { phase: 'day', t: 0.3 } });
  src.send({ t: 'full', topic: 'world', data: { now: serverAt(0), rooms: [room('a', 0), room('b', 12)], agents: [pos('Pip', 'a')], drama: {} } });
  const at = (t: number) => {
    clock = t;
  };
  const move = (t: number, r: string) => {
    at(t);
    src.send({ t: 'batch', topic: 'world', now: serverAt(t), events: [], pos: [pos('Pip', r)] });
  };
  return { store, src, at, move, serverAt };
}

describe('the store with the broadcast delay', () => {
  it('shows the world as it was: a move arriving now appears later, in order', () => {
    const { store, at, move } = setup();
    store.setDelay(true);
    move(10_000, 'b'); // held 5 s
    move(12_000, 'a'); // held 6 s
    expect(store.state.agents.get('Pip')!.r).toBe('a');
    at(15_000);
    store.pumpDelay();
    expect(store.state.agents.get('Pip')!.r).toBe('b');
    at(18_000);
    store.pumpDelay();
    expect(store.state.agents.get('Pip')!.r).toBe('a');
  });

  it('the display clock runs behind real time by the lag', () => {
    const { store, at, move, serverAt } = setup();
    store.setDelay(true);
    move(60_000, 'b'); // held 30 s
    at(90_000);
    store.pumpDelay();
    expect(store.lagMs()).toBe(30_000);
    // the newest message applied was sent at 60 s: the screen shows the world as it was then
    expect(store.displayNow()).toBe(serverAt(60_000));
  });

  it('pausing the director shows the live state at once and stops delaying', () => {
    const { store, at, move, serverAt } = setup();
    store.setDelay(true);
    move(20_000, 'b');
    expect(store.state.agents.get('Pip')!.r).toBe('a');
    at(21_000);
    store.setDelay(false);
    expect(store.state.agents.get('Pip')!.r).toBe('b');
    expect(store.lagMs()).toBe(0);
    move(22_000, 'a');
    expect(store.state.agents.get('Pip')!.r).toBe('a');
    expect(store.displayNow()).toBe(serverAt(22_000));
  });

  it('a reconnect applies what was held and builds the lag again, so old batches never follow the new fulls', () => {
    const { store, src, at, move, serverAt } = setup();
    store.setDelay(true);
    move(40_000, 'b'); // held 20 s
    at(41_000);
    src.send({ t: 'hello', now: serverAt(41_000), day: { phase: 'day', t: 0.3 } });
    expect(store.state.agents.get('Pip')!.r).toBe('b');
    expect(store.lagMs()).toBe(0);
    src.send({ t: 'full', topic: 'world', data: { now: serverAt(41_000), rooms: [room('a', 0), room('b', 12)], agents: [pos('Pip', 'a')], drama: {} } });
    expect(store.state.agents.get('Pip')!.r).toBe('a');
    at(100_000);
    store.pumpDelay();
    expect(store.state.agents.get('Pip')!.r).toBe('a');
  });

  it('a hidden tab goes live and the delay builds again when it comes back', () => {
    const { store, at, move } = setup();
    store.setDelay(true);
    move(20_000, 'b');
    store.setHidden(true);
    expect(store.delaying).toBe(false);
    expect(store.state.agents.get('Pip')!.r).toBe('b');
    at(25_000);
    store.setHidden(false);
    expect(store.delaying).toBe(true);
    expect(store.lagMs()).toBe(0);
    // a tab hidden while the director was paused stays live
    store.setDelay(false);
    store.setHidden(true);
    store.setHidden(false);
    expect(store.delaying).toBe(false);
  });

  it('the scout sees every message at once, delayed or not', () => {
    const { store, src, at, serverAt } = setup();
    store.setDelay(true);
    at(10_000);
    src.send({ t: 'batch', topic: 'world', now: serverAt(10_000), events: [], interest: [{ n: 'Pip', r: 'a', p: 16, e: 'fallen' }] });
    expect(store.scout.increments()).toEqual([{ n: 'Pip', r: 'a', p: 16, e: 'fallen', ts: serverAt(10_000) }]);
    expect(store.state.roomLogs.size).toBe(0);
  });

  it('a topic counts as buffered once it has been held longer than the lag', () => {
    const { store, at } = setup();
    store.setDelay(true);
    at(30_000); // lag 10 s
    store.setTopics('scout', ['room:b']);
    expect(store.isBuffered('room:b')).toBe(false);
    at(44_000); // lag about 14.7 s, held 14 s
    expect(store.isBuffered('room:b')).toBe(false);
    at(46_000); // lag about 15.3 s, held 16 s
    expect(store.isBuffered('room:b')).toBe(true);
    expect(store.isBuffered('room:a')).toBe(false);
  });
});
