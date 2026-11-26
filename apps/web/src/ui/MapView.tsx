import { useEffect, useRef } from 'react';
import { config } from '../config';
import { store } from '../data/store';
import { useT } from '../i18n/store';
import { MapScene } from '../map/scene';
import { useApp } from './context';

/** Hosts the Pixi scene. The scene lives outside React and reads the store directly. */
export function MapView() {
  const host = useRef<HTMLDivElement>(null);
  const { source, world } = useApp();
  const tr = useT();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let scene: MapScene | null = null;
    let cancelled = false;
    MapScene.create(el, {
      source,
      store,
      world,
      phase: config.phase,
      reducedMotion: config.reducedMotion,
      ...(config.zoom ? { zoom: config.zoom } : {}),
    })
      .then((s) => {
        if (cancelled) s.destroy();
        else scene = s;
      })
      .catch((err: unknown) => console.error('[ajwf] map failed to start', err));
    return () => {
      cancelled = true;
      scene?.destroy();
    };
  }, [source, world]);

  return <div ref={host} className="map-host" role="img" aria-label={tr.t('ui.map.canvas_label')} />;
}
