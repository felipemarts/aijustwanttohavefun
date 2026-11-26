import type { GameEvent, SpectatorEvent, Visibility } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { SPECTATE } from './constants';
import { decay, DramaBoard } from './drama';
import { Ring, RoomLogs } from './room-log';
import { isSpectatorVisible, toSpectatorEvent, type EventLookup } from './visibility';

const look: EventLookup = {
  agentName: (id) => ({ a1: 'Pip', a2: 'Brasa' })[id],
  isNpc: (id) => id === 'olga',
};

const ev = (o: Partial<GameEvent>): GameEvent => ({ id: '1', ts: 0, type: 'emote', visibility: 'room', payload: {}, ...o });

describe('visibility filter (the security boundary)', () => {
  it('lets public and room events through and stops private and delayed ones', () => {
    const all: Record<Visibility, boolean> = { public: true, room: true, private: false, delayed: false };
    for (const [visibility, shown] of Object.entries(all) as [Visibility, boolean][]) {
      expect(isSpectatorVisible({ visibility }), visibility).toBe(shown);
    }
  });

  it('refuses anything that is not a known public visibility', () => {
    for (const v of ['', 'PUBLIC', 'secret', undefined, null]) expect(isSpectatorVisible({ visibility: v as unknown as Visibility })).toBe(false);
  });
});

describe('toSpectatorEvent', () => {
  it('sends agent text only as `text` with its language, never as a key', () => {
    const out = toSpectatorEvent(ev({ type: 'say', actor: 'a1', roomId: 'village.square', lang: 'pt-BR', drama: 1, payload: { text: 'Olá!' } }), look);
    expect(out).toEqual({ id: '1', ts: 0, type: 'say', room: 'village.square', actor: 'Pip', text: 'Olá!', lang: 'pt-BR', drama: 1 });
    expect(out.k).toBeUndefined();
    expect(out.p).toBeUndefined();
  });

  it('a text event never carries a key even if the payload has one', () => {
    const out = toSpectatorEvent(ev({ type: 'say', actor: 'a1', payload: { text: 'hi', m: { k: 'ev.move', p: { actor: 'x' } } } }), look);
    expect(out.k).toBeUndefined();
    expect(out.text).toBe('hi');
  });

  it('sends other events as key + params, agents resolved to names, other references left for the client', () => {
    const out = toSpectatorEvent(
      ev({
        type: 'kill',
        actor: 'a1',
        target: 'm9',
        payload: { m: { k: 'ev.kill', p: { actor: '@agent:a2', target: '@mon:slime', n: 3, junk: { x: 1 } } }, mon: 'slime', gold: { a1: 5 } },
      }),
      look,
    );
    expect(out).toEqual({ id: '1', ts: 0, type: 'kill', actor: 'Pip', target: 'slime', tk: 'mon', k: 'ev.kill', p: { actor: 'Brasa', target: '@mon:slime', n: 3 } });
    // Agent ids and unlisted payload fields (such as per-agent gold) never leave the server.
    expect(JSON.stringify(out)).not.toMatch(/a1|a2|gold/);
  });

  it('names agent and NPC targets', () => {
    expect(toSpectatorEvent(ev({ actor: 'a1', target: 'a2' }), look)).toMatchObject({ actor: 'Pip', target: 'Brasa', tk: 'agent' });
    expect(toSpectatorEvent(ev({ actor: 'a1', target: 'olga' }), look)).toMatchObject({ target: 'olga', tk: 'npc' });
    expect(toSpectatorEvent(ev({ actor: 'a1', target: 'm1' }), look).target).toBeUndefined();
  });
});

describe('drama decay', () => {
  it('halves every half-life', () => {
    const h = SPECTATE.dramaHalfLifeMs;
    expect(h).toBe(60_000);
    expect(decay(10, 0)).toBe(10);
    expect(decay(10, h)).toBeCloseTo(5, 10);
    expect(decay(10, 2 * h)).toBeCloseTo(2.5, 10);
    expect(decay(10, h / 2)).toBeCloseTo(10 / Math.SQRT2, 10);
    expect(decay(8, -5)).toBe(8);
  });

  it('accumulates lazily, ranks the hottest rooms and forgets cold ones', () => {
    const d = new DramaBoard();
    d.add('a', 4, 0);
    d.add('a', 4, 60_000); // 4 decayed to 2, plus 4
    expect(d.score('a', 60_000)).toBeCloseTo(6, 10);
    d.add('b', 10, 60_000);
    d.add('c', 1, 60_000);
    expect(Object.keys(d.top(2, 60_000))).toEqual(['b', 'a']);
    expect(d.top(5, 120_000)).toEqual({ b: 5, a: 3, c: 0.5 });
    // Ten half-lives later everything is under the floor and dropped.
    expect(d.top(5, 60_000 + 10 * 60_000)).toEqual({});
    expect(d.score('a', 60_000 + 10 * 60_000)).toBe(0);
  });
});

describe('room log ring', () => {
  it('keeps the last 50 events per room, oldest first', () => {
    const logs = new RoomLogs();
    const se = (i: number): SpectatorEvent => ({ id: String(i), ts: i, type: 'say', text: `m${i}` });
    for (let i = 1; i <= 60; i++) logs.push('r1', se(i));
    logs.push('r2', se(61));
    const r1 = logs.list('r1');
    expect(r1).toHaveLength(SPECTATE.roomLogSize);
    expect(r1[0]!.id).toBe('11');
    expect(r1.at(-1)!.id).toBe('60');
    expect(logs.list('r2').map((e) => e.id)).toEqual(['61']);
    expect(logs.list('r1', 20).map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => String(11 + i)));
    expect(logs.since('r1', 58).map((e) => e.id)).toEqual(['59', '60']);
    expect(logs.list('nowhere')).toEqual([]);
  });

  it('Ring wraps around', () => {
    const r = new Ring<number>(3);
    for (let i = 1; i <= 7; i++) r.push(i);
    expect(r.list()).toEqual([5, 6, 7]);
    expect(r.size).toBe(3);
  });
});
