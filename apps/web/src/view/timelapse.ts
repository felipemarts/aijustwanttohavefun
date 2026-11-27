/**
 * Timelapse replay: the village timeline (`GET /api/public/timeline`) sorted into a stable order and folded into the
 * state of every plot at any instant. Pure.
 */
import type { TimelineEntry } from '@ajwf/shared';

/** Oldest first; ties broken by the numeric part of the id (the order the server recorded them). */
export function sortTimeline(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const seq = (id: string) => {
    const m = /(\d+)/.exec(id);
    return m ? Number(m[1]) : 0;
  };
  return [...entries].sort((a, b) => a.ts - b.ts || seq(a.id) - seq(b.id) || a.id.localeCompare(b.id));
}

export type ReplayProject = { id: string; plot: string; building: string | null; progress: number; done: boolean; available: boolean };
export type ReplayState = {
  /** project id -> state */
  projects: Map<string, ReplayProject>;
  /** plot -> guild hall */
  halls: Map<string, { guild: string; colors: [string, string] }>;
  honoree: string | null;
  /** How many entries have been applied. */
  applied: number;
  /** The last entry applied (the caption). */
  last: TimelineEntry | null;
};

export function emptyReplay(): ReplayState {
  return { projects: new Map(), halls: new Map(), honoree: null, applied: 0, last: null };
}

export function applyEntry(s: ReplayState, e: TimelineEntry): void {
  const proj = (id: string) => {
    let p = s.projects.get(id);
    if (!p) {
      p = { id, plot: e.plot ?? '', building: e.building ?? null, progress: 0, done: false, available: false };
      s.projects.set(id, p);
    }
    if (e.plot) p.plot = e.plot;
    if (e.building) p.building = e.building;
    return p;
  };
  switch (e.type) {
    case 'project_available':
      if (e.project) proj(e.project).available = true;
      break;
    case 'project_started':
    case 'project_progress':
      if (e.project) {
        const p = proj(e.project);
        p.available = true;
        // progress never goes back (§8.1)
        p.progress = Math.max(p.progress, e.progress ?? (e.type === 'project_started' ? 0.01 : p.progress));
      }
      break;
    case 'project_completed':
      if (e.project) {
        const p = proj(e.project);
        p.available = true;
        p.progress = 1;
        p.done = true;
      }
      break;
    case 'hall_built':
      if (e.plot && e.guild) s.halls.set(e.plot, { guild: e.guild, colors: e.colors ?? ['#d9534f', '#f2b84b'] });
      break;
    case 'hall_removed':
      if (e.plot) s.halls.delete(e.plot);
      break;
    case 'statue_honor':
      if (e.name) s.honoree = e.name;
      break;
  }
  s.applied++;
  s.last = e;
}

/** State after every entry with `ts <= t` (entries must be sorted). */
export function replayUntil(sorted: readonly TimelineEntry[], t: number): ReplayState {
  const s = emptyReplay();
  for (const e of sorted) {
    if (e.ts > t) break;
    applyEntry(s, e);
  }
  return s;
}

/** The time span to replay, with a little lead-in before the first entry. */
export function replaySpan(sorted: readonly TimelineEntry[]): [number, number] {
  if (!sorted.length) return [0, 0];
  const a = sorted[0]!.ts;
  const b = sorted[sorted.length - 1]!.ts;
  const lead = Math.max(60_000, (b - a) * 0.02);
  return [a - lead, b + lead];
}
