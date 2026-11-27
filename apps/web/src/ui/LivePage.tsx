import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { config } from '../config';
import { BROADCAST_DELAY } from '../data/delay';
import { useStatus } from '../data/store';
import { useT } from '../i18n/store';
import { controller, useDirector, usePanel } from '../map/controller';
import { directorVoice, useDirectorVoice } from '../map/voice';
import { AgentCard } from './AgentCard';
import { DebugHud } from './DebugHud';
import { DirectorCaption } from './DirectorCaption';
import { HighlightsTicker } from './HighlightsTicker';
import { MapView } from './MapView';
import { RoomPanel } from './RoomPanel';
import { StarCard } from './StarCard';

/**
 * Spoken director mode: one toggle, offered only while the director is on and the browser has a voice for the
 * interface language (English or Portuguese). The click is also the user gesture browsers require before speaking.
 */
function SoundToggle() {
  const tr = useT();
  const voice = useDirectorVoice();
  if (!voice.available) return null;
  return (
    <button
      type="button"
      className={`btn sound-toggle ${voice.on ? 'is-on' : ''}`}
      aria-pressed={voice.on}
      title={tr.t('ui.director.sound.hint')}
      onClick={() => directorVoice.toggle()}
    >
      <svg
        className="snd-icon"
        viewBox="0 0 12 10"
        width="14"
        height="12"
        aria-hidden="true"
        shapeRendering="crispEdges"
      >
        <path d="M0 3h3l3-3h1v10h-1l-3-3h-3z" fill="currentColor" />
        {voice.on ? (
          <path d="M9 3h1v4h-1zM11 1h1v8h-1z" fill="currentColor" />
        ) : (
          <path d="M9 3h1v1h-1zM11 3h1v1h-1zM10 4h1v2h-1zM9 6h1v1h-1zM11 6h1v1h-1z" fill="currentColor" />
        )}
      </svg>
      <span className="snd-label">
        {voice.on ? tr.t('ui.director.sound.on') : tr.t('ui.director.sound.off')}
      </span>
    </button>
  );
}

export function LivePage() {
  const tr = useT();
  const panel = usePanel();
  const director = useDirector();
  const status = useStatus();
  const [params] = useSearchParams();
  const focus = params.get('room');
  // `/?room=<id>` (links from highlights, guild halls, profiles): open that room once the map is ready.
  useEffect(() => {
    if (focus && /^[a-z0-9_.]{1,80}$/.test(focus)) controller.showRoom(focus);
  }, [focus]);
  // The director's voice lives with this page: leaving it silences everything.
  useEffect(() => directorVoice.attach(), []);
  return (
    <div className="live">
      <MapView />
      <DirectorCaption />
      <StarCard />
      {status !== 'live' ? (
        <div className="conn-banner pixel-box" role="status">
          <span className="spinner" aria-hidden="true" />
          {tr.t(`ui.status.${status}`)}
        </div>
      ) : null}
      <div className="map-controls">
        <div className="director-control">
          <div className="director-row">
            <button
              type="button"
              className={`btn director-toggle ${director.enabled ? 'is-on' : ''}`}
              aria-pressed={director.enabled}
              onClick={() => (director.enabled ? controller.pauseDirector() : controller.resumeDirector())}
            >
              <span className="dir-dot" aria-hidden="true" />
              {director.enabled ? tr.t('ui.director.on') : tr.t('ui.director.resume')}
            </button>
            {director.enabled ? <SoundToggle /> : null}
          </div>
          {/* Director mode plays the world with a delay (it looks ahead to choose whom to follow); manual is live. */}
          <span className={`broadcast-tag ${director.enabled ? 'is-delayed' : 'is-live'}`}>
            {director.enabled
              ? tr.t('ui.director.delay', { s: Math.round(BROADCAST_DELAY.maxMs / 1000) })
              : tr.t('ui.director.live')}
          </span>
        </div>
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
