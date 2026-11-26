import { config } from '../config';
import { useStatus } from '../data/store';
import { useT } from '../i18n/store';
import { controller, useDirector, usePanel } from '../map/controller';
import { AgentCard } from './AgentCard';
import { DebugHud } from './DebugHud';
import { DirectorCaption } from './DirectorCaption';
import { HighlightsTicker } from './HighlightsTicker';
import { MapView } from './MapView';
import { RoomPanel } from './RoomPanel';

export function LivePage() {
  const tr = useT();
  const panel = usePanel();
  const director = useDirector();
  const status = useStatus();
  return (
    <div className="live">
      <MapView />
      <DirectorCaption />
      {status !== 'live' ? (
        <div className="conn-banner pixel-box" role="status">
          <span className="spinner" aria-hidden="true" />
          {tr.t(`ui.status.${status}`)}
        </div>
      ) : null}
      <div className="map-controls">
        <button
          type="button"
          className={`btn director-toggle ${director.enabled ? 'is-on' : ''}`}
          aria-pressed={director.enabled}
          onClick={() => (director.enabled ? controller.pauseDirector() : controller.resumeDirector())}
        >
          <span className="dir-dot" aria-hidden="true" />
          {director.enabled ? tr.t('ui.director.on') : tr.t('ui.director.resume')}
        </button>
        <div className="zoom-buttons">
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => controller.commands?.zoom(1)}
            aria-label={tr.t('ui.map.zoom_in')}
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => controller.commands?.zoom(-1)}
            aria-label={tr.t('ui.map.zoom_out')}
          >
            −
          </button>
        </div>
      </div>
      {panel?.kind === 'room' ? <RoomPanel key={panel.id} roomId={panel.id} /> : null}
      {panel?.kind === 'agent' ? <AgentCard key={panel.name} name={panel.name} /> : null}
      <HighlightsTicker />
      {config.debug ? <DebugHud /> : null}
    </div>
  );
}
