/** The mock is the demo and the fixture: every page gets believable data from it, through the real parsers. */
import { describe, expect, it } from 'vitest';
import { loadStaticWorld } from '../test/fixtures';
import {
  parseBoard,
  parseEdition,
  parseFullProfile,
  parseGazetteIndex,
  parseGuild,
  parseHighlightPage,
  parseHistory,
  parseLeaderboard,
  parseSecrets,
  parseTimeline,
  parseVillage,
} from './api';
import { MockSource } from './mock';
import { LiveStore } from './store';

describe('mock civic data', () => {
  const world = loadStaticWorld();
  const src = new MockSource(world, { seed: 3, agents: 30, autoTick: false, now: Date.UTC(2026, 10, 26, 12) });

  it('answers every page with data in every state', async () => {
    const v = parseVillage(await src.getJson('/api/public/village'))!;
    expect(new Set(v.projects.map((p) => p.status))).toEqual(new Set(['done', 'available', 'locked']));
    expect(v.projects.some((p) => p.status === 'available' && p.progress > 0)).toBe(true);
    expect(v.election?.phase).toBe('voting');
    expect(v.election?.candidates.length).toBeGreaterThanOrEqual(3);
    // Secret ballot: the mock, like the server, never sends a live total, only the turnout.
    expect(v.election?.voters).toBeGreaterThan(0);
    expect(JSON.stringify((await src.getJson('/api/public/village') as { election: unknown }).election)).not.toMatch(/"votes"/);
    expect(v.honoree?.name).toBeTruthy();
    expect(Object.keys(v.halls).length).toBeGreaterThanOrEqual(1);
    expect(parseHistory(await src.getJson('/api/public/village/history')).length).toBeGreaterThanOrEqual(7);
    expect(parseTimeline(await src.getJson('/api/public/timeline')).some((e) => e.type === 'hall_built')).toBe(true);

    const hl = parseHighlightPage(await src.getJson('/api/public/highlights?limit=30'));
    expect(new Set(hl.highlights.map((h) => h.type)).size).toBeGreaterThanOrEqual(8);
    expect(hl.highlights.some((h) => h.quote)).toBe(true);
    const older = parseHighlightPage(await src.getJson(`/api/public/highlights?limit=30&before=${hl.next}`));
    expect(older.highlights.every((h) => !hl.highlights.some((x) => x.id === h.id))).toBe(true);

    const idx = parseGazetteIndex(await src.getJson('/api/public/gazette'));
    expect(idx.length).toBe(7);
    const ed = parseEdition(await src.getJson(`/api/public/gazette/${idx[0]!.date}`))!;
    expect(ed.sections.length).toBeGreaterThanOrEqual(6);

    const s1 = parseSecrets(await src.getJson('/api/public/secrets?limit=40'));
    expect(new Set(s1.conversations.map((c) => c.channel))).toEqual(new Set(['whisper', 'party', 'guild']));
    expect(s1.next).not.toBeNull();
    const s2 = parseSecrets(await src.getJson(`/api/public/secrets?limit=40&before=${s1.next}`));
    expect(s2.conversations.length).toBeGreaterThan(0);

    expect(parseBoard(await src.getJson('/api/public/board?tag=rumor')).posts.every((p) => p.tag === 'rumor')).toBe(true);
    expect(parseLeaderboard(await src.getJson('/api/public/leaderboard?by=wealth'))!.rows.length).toBeGreaterThan(10);
    const g = parseGuild(await src.getJson('/api/public/guilds/Iron%20Lanterns'))!;
    expect(g.hall?.plot).toBe('village.plot_far');
    const name = src.agentNames()[0]!;
    const p = parseFullProfile(await src.getJson(`/api/public/agents/${encodeURIComponent(name)}`))!;
    expect(p.xp).not.toBeNull();
    expect(p.xp!.next).toBeGreaterThan(p.xp!.cur);
    expect(p.profession).toBeTruthy();
    expect(p.bio?.lang).toMatch(/^[a-z]{2}/);
    expect(g.motto?.lang).toMatch(/^[a-z]{2}/);
    expect(p.reputation).not.toBeNull();
  });

  it('the village full carries the statue honoree into the store, so the map needs no fetch', async () => {
    const store = new LiveStore(() => 0);
    const s = new MockSource(world, { seed: 5, agents: 20, autoTick: false, builtAll: true });
    store.start(s);
    const v = parseVillage(await s.getJson('/api/public/village'))!;
    expect(v.honoree).not.toBeNull();
    expect(store.state.honoree).toEqual({ name: v.honoree!.name, sprite: v.honoree!.sprite });
    expect(store.state.honoree!.sprite).toMatch(/^[0-9a-f]{6,64}$/);
    store.stop();
  });

  it('a project completing reaches the store as a completion and a highlight', () => {
    let clock = 0;
    const store = new LiveStore(() => clock);
    const s = new MockSource(world, { seed: 5, agents: 20, autoTick: false });
    store.start(s);
    const completed: string[] = [];
    store.onChanges((ch) => completed.push(...ch.completed));
    expect(store.state.projects.find((p) => p.id === 'library')?.done).toBe(false);
    s.completeProject('library');
    clock += 250;
    s.tick(250);
    expect(completed).toContain('library');
    expect(store.state.projects.find((p) => p.id === 'library')?.done).toBe(true);
    expect(store.state.highlights.some((h) => h.type === 'project_completed')).toBe(true);
    store.stop();
  });
});
