/**
 * What stands on each construction site, from live data: an empty lot, scaffolding with progress, the finished
 * building, a guild hall, or (for rooms a project rebuilds) the room as it is today. Pure.
 */
import type { HallInfo } from '@ajwf/shared';
import type { Project } from '../data/reducers';
import type { StaticWorld } from '../data/staticWorld';

export type SiteMode = 'none' | 'lot' | 'base' | 'work' | 'done' | 'hall';

export type SiteState = {
  mode: SiteMode;
  /** Building id drawn when done. */
  building: string;
  project: string | null;
  progress: number;
  hall: HallInfo | null;
};

export type SiteInputs = {
  projects: readonly Project[];
  /** plot -> project id */
  buildings: Readonly<Record<string, string>>;
  halls: Readonly<Record<string, HallInfo>>;
  /** `RoomInfo.building` from the server, when it says what stands on a room. */
  roomBuilding?: string | null;
};

/**
 * `plot`: a free village plot. `variant`: a room whose own look a project replaces (tavern, market, gate, square).
 * Anything else (the bridge) shows nothing until work starts.
 */
export function siteState(roomId: string, kind: 'plot' | 'variant' | 'other', inp: SiteInputs, world: StaticWorld | null): SiteState {
  const proj = inp.projects.find((p) => p.plot === roomId) ?? null;
  const builtId = inp.buildings[roomId] ?? (proj?.done ? proj.id : null);
  const buildingOf = (projectId: string) =>
    world?.projects.find((p) => p.id === projectId)?.building ?? proj?.building ?? projectId;
  const hall = inp.halls[roomId] ?? null;
  if (hall) return { mode: 'hall', building: 'guild_hall', project: null, progress: 1, hall };
  if (builtId) return { mode: 'done', building: buildingOf(builtId), project: builtId, progress: 1, hall: null };
  if (inp.roomBuilding) return { mode: 'done', building: inp.roomBuilding, project: proj?.id ?? null, progress: 1, hall: null };
  if (proj && proj.progress > 0) return { mode: 'work', building: buildingOf(proj.id), project: proj.id, progress: proj.progress, hall: null };
  const idle: SiteMode = kind === 'plot' ? 'lot' : kind === 'variant' ? 'base' : 'none';
  return { mode: idle, building: proj ? buildingOf(proj.id) : '', project: proj?.id ?? null, progress: 0, hall: null };
}

/** A key that changes exactly when the picture of the site must change. */
export function siteKey(s: SiteState): string {
  return s.mode === 'hall' ? `hall:${s.hall!.guild}:${s.hall!.colors.join(',')}` : `${s.mode}:${s.building}`;
}
