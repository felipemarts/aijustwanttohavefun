import type { GameEvent, TimelineEntry } from '@ajwf/shared';

/**
 * The village timeline (timelapse page): building-related events reduced to the steps the map shows. Pure, with a
 * little memory (the last quarter each project reached) passed in by the caller.
 */

/** Event types that may produce a timeline entry. */
export const TIMELINE_TYPES: ReadonlySet<string> = new Set([
  'project_available',
  'project_contribution',
  'mayor_fund',
  'project_completed',
  'guild_hall_built',
  'guild_disbanded',
  'statue_honor',
]);

/** Progress is recorded in quarters: a start, 25, 50 and 75 %, then completion. */
const STEP = 0.25;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export type TimelineMemory = {
  /** project id -> highest quarter recorded (0 = started). */
  quarters: Map<string, number>;
  /** guild id -> plot of its hall, to know which plot a disbanded guild frees. */
  halls: Map<string, string>;
  /** project id -> site and building. */
  sites: Map<string, { site: string; building: string }>;
};

export function newTimelineMemory(): TimelineMemory {
  return { quarters: new Map(), halls: new Map(), sites: new Map() };
}

export function timelineEntry(ev: GameEvent, mem: TimelineMemory, agentName: (id: string) => string | undefined): TimelineEntry | null {
  const id = `t${ev.id}`;
  const base = { id, ts: ev.ts };
  switch (ev.type) {
    case 'project_available': {
      const project = str(ev.payload.project);
      return { ...base, type: 'project_available', project, plot: str(ev.payload.site) };
    }
    case 'project_contribution':
    case 'mayor_fund': {
      const project = str(ev.payload.project);
      const progress = num(ev.payload.progress);
      if (!project || progress >= 1) return null;
      const q = Math.floor(progress / STEP);
      const seen = mem.quarters.get(project);
      if (seen !== undefined && q <= seen) return null;
      mem.quarters.set(project, q);
      const site = mem.sites.get(project);
      return {
        ...base,
        type: seen === undefined ? 'project_started' : 'project_progress',
        project,
        progress: Math.round(progress * 1000) / 1000,
        ...(site ? { plot: site.site, building: site.building } : {}),
      };
    }
    case 'project_completed': {
      const project = str(ev.payload.project);
      mem.quarters.set(project, 4);
      return { ...base, type: 'project_completed', project, plot: str(ev.payload.site), building: str(ev.payload.building), progress: 1 };
    }
    case 'guild_hall_built': {
      const plot = str(ev.payload.plot);
      mem.halls.set(str(ev.payload.guild), plot);
      const colors = ev.payload.colors;
      return { ...base, type: 'hall_built', plot, guild: str(ev.payload.name), ...(Array.isArray(colors) && colors.length === 2 ? { colors: [str(colors[0]), str(colors[1])] as [string, string] } : {}) };
    }
    case 'guild_disbanded': {
      const guildId = str(ev.payload.guild) || ev.target || '';
      const plot = mem.halls.get(guildId);
      if (!plot) return null;
      mem.halls.delete(guildId);
      return { ...base, type: 'hall_removed', plot, guild: str(ev.payload.name) };
    }
    case 'statue_honor':
      return { ...base, type: 'statue_honor', name: (ev.actor && agentName(ev.actor)) || str(ev.payload.name) };
    default:
      return null;
  }
}
