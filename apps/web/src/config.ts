/**
 * URL switches: `?mock=1` (in-browser simulation), `?stress=500`, `?debug=1`, `?phase=night`, `?zoom=2`,
 * `?built=all` (mock: every village project already built).
 */
import type { DayPhase } from '@ajwf/shared';

export type AppConfig = {
  mock: boolean;
  stress: number;
  debug: boolean;
  phase: DayPhase | null;
  zoom: number | null;
  reducedMotion: boolean;
  builtAll: boolean;
};

export function parseConfig(search: string, reducedMotion: boolean): AppConfig {
  const q = new URLSearchParams(search);
  const stress = Math.max(0, Math.min(5000, Number.parseInt(q.get('stress') ?? '0', 10) || 0));
  const phase = q.get('phase');
  const zoom = Number.parseFloat(q.get('zoom') ?? '');
  return {
    mock: q.get('mock') === '1' || stress > 0,
    stress,
    debug: q.get('debug') === '1',
    phase: phase === 'dawn' || phase === 'day' || phase === 'dusk' || phase === 'night' ? phase : null,
    zoom: Number.isFinite(zoom) && zoom > 0.1 && zoom <= 8 ? zoom : null,
    reducedMotion,
    builtAll: q.get('built') === 'all',
  };
}

export const config: AppConfig =
  typeof window === 'undefined'
    ? parseConfig('', false)
    : parseConfig(
        window.location.search,
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      );
