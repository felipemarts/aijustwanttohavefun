import { useT } from '../i18n/store';
import { useDirectorDebug, useStats } from '../map/controller';

/** `?debug=1`: frame rate and scene counters, to measure the stress mode, and what the director is thinking. */
export function DebugHud() {
  const tr = useT();
  const s = useStats();
  const d = useDirectorDebug();
  const rows: [string, string | number][] = [
    ['ui.debug.fps', s.fps],
    ['ui.debug.frame', `${s.frameMs} ms`],
    ['ui.debug.update', `${s.updateMs} ms`],
    ['ui.debug.agents', `${s.visible} / ${s.agents}`],
    ['ui.debug.labels', s.labels],
    ['ui.debug.lod', `${s.lod} @ ${s.scale}`],
    ['ui.debug.atlas', s.atlasPages],
    ['ui.debug.renderer', s.renderer],
    ['ui.debug.star', d.star ?? '-'],
    ['ui.debug.lag', `${(d.lagMs / 1000).toFixed(1)} s`],
    ['ui.debug.scout', d.scoutRooms],
    ['ui.debug.interest', d.top.map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ') || '-'],
  ];
  return (
    <div className="debug-hud pixel-box" data-testid="debug-hud">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="muted">{tr.t(k)}</span> <b data-k={k}>{v}</b>
        </div>
      ))}
    </div>
  );
}
