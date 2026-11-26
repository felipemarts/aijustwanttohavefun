import { describe, expect, it } from 'vitest';
import { agentSpot, floorOf, neighbourDir, pointAlong, roomPx, walkRoute } from './geometry';
import { lodFor, nearestStep, pickLabels, stepFrom, zoomSteps } from './lod';

const room = { id: 'village.square', rect: [72, 40, 10, 8] as [number, number, number, number] };

describe('agent layout', () => {
  it('gives each agent a stable spot on the room floor', () => {
    const f = floorOf(roomPx(room));
    for (const name of ['Pip', 'Bo', 'Zed', '名前', 'a_very_long_agent_name']) {
      const a = agentSpot(room, name);
      expect(agentSpot(room, name)).toEqual(a);
      expect(a.x).toBeGreaterThanOrEqual(f.x);
      expect(a.x).toBeLessThanOrEqual(f.x + f.w);
      expect(a.y).toBeGreaterThanOrEqual(f.y);
      expect(a.y).toBeLessThanOrEqual(f.y + f.h);
    }
  });

  it('spreads agents instead of stacking them', () => {
    const spots = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(agentSpot(room, `agent${i}`))));
    expect(spots.size).toBeGreaterThan(45);
  });

  it('walks between neighbours through the exit edges', () => {
    const a = roomPx(room);
    const b = roomPx({ rect: [84, 40, 10, 8] });
    expect(neighbourDir(a, b)).toBe('east');
    const route = walkRoute(a, b, { x: a.x + 10, y: a.y + 100 }, { x: b.x + 50, y: b.y + 90 })!;
    expect(route).toHaveLength(4);
    expect(route[1]!.x).toBe(a.x + a.w);
    expect(route[2]!.x).toBe(b.x);
    expect(pointAlong(route, 1e9)).toEqual(route[3]);
    expect(walkRoute(a, roomPx({ rect: [0, 90, 10, 8] }), route[0]!, route[3]!)).toBeNull();
  });
});

describe('level of detail', () => {
  it('switches dots, sprites and full detail by zoom', () => {
    expect(lodFor(0.5)).toBe('dot');
    expect(lodFor(1)).toBe('sprite');
    expect(lodFor(2)).toBe('full');
  });

  it('caps labels and keeps the important ones', () => {
    const cands = Array.from({ length: 200 }, (_, i) => ({ name: `a${i}`, x: i * 10, y: 0, priority: 0 }));
    cands[150]!.priority = 3;
    const picked = pickLabels(cands, 0, 0, 20);
    expect(picked.size).toBe(20);
    expect(picked.has('a150')).toBe(true);
    expect(picked.has('a0')).toBe(true);
    expect(picked.has('a199')).toBe(false);
  });

  it('uses crisp zoom steps for the device pixel ratio', () => {
    expect(zoomSteps(2)).toContain(1.5);
    expect(zoomSteps(1)).toContain(2);
    const steps = zoomSteps(1);
    expect(nearestStep(steps, 2.2)).toBe(2);
    expect(stepFrom(steps, 2, 1)).toBe(3);
    expect(stepFrom(steps, 2, -1)).toBe(1);
  });
});
