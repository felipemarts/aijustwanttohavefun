/**
 * UI-facing state of the live map, outside React: the open panel, director mode, follow, debug stats. The Pixi scene
 * writes it and registers its commands; React reads it through the hooks below.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Caption } from './director';

export type Panel = { kind: 'room'; id: string } | { kind: 'agent'; name: string } | null;

export type DirectorUi = { enabled: boolean; room: string | null; caption: Caption | null; seq: number };

export type SceneStats = {
  fps: number;
  frameMs: number;
  updateMs: number;
  agents: number;
  visible: number;
  labels: number;
  lod: string;
  scale: number;
  atlasPages: number;
  renderer: string;
};

export type SceneCommands = {
  zoom(dir: 1 | -1): void;
  focusRoom(id: string): void;
  focusAgent(name: string): void;
};

type Listener = () => void;

class MapController {
  panel: Panel = null;
  director: DirectorUi = { enabled: true, room: null, caption: null, seq: 0 };
  follow: string | null = null;
  stats: SceneStats = {
    fps: 0,
    frameMs: 0,
    updateMs: 0,
    agents: 0,
    visible: 0,
    labels: 0,
    lod: '',
    scale: 0,
    atlasPages: 0,
    renderer: '',
  };
  commands: SceneCommands | null = null;
  /** A room to show as soon as the map is ready (`/?room=<id>` links). */
  pendingFocus: string | null = null;
  private listeners = new Map<string, Set<Listener>>();

  subscribe(channel: string, l: Listener) {
    let s = this.listeners.get(channel);
    if (!s) this.listeners.set(channel, (s = new Set()));
    s.add(l);
    return () => {
      s.delete(l);
    };
  }

  private emit(channel: string) {
    for (const l of this.listeners.get(channel) ?? []) l();
  }

  /** Opens a room and moves the camera there, now or once the scene has started. */
  showRoom(id: string) {
    this.openRoom(id);
    if (this.commands) this.commands.focusRoom(id);
    else this.pendingFocus = id;
  }

  openRoom(id: string) {
    this.panel = { kind: 'room', id };
    this.emit('panel');
  }

  openAgent(name: string) {
    this.panel = { kind: 'agent', name };
    this.emit('panel');
  }

  closePanel() {
    this.panel = null;
    this.pendingFocus = null;
    if (this.follow) this.setFollow(null);
    this.emit('panel');
  }

  setFollow(name: string | null) {
    if (this.follow === name) return;
    this.follow = name;
    if (name) this.pauseDirector();
    this.emit('follow');
  }

  /** Any manual pan, zoom or click pauses the director. */
  pauseDirector() {
    if (!this.director.enabled) return;
    this.director = { ...this.director, enabled: false };
    this.emit('director');
  }

  resumeDirector() {
    if (this.follow) this.setFollow(null);
    this.director = { ...this.director, enabled: true };
    this.emit('director');
  }

  setDirectorRoom(room: string, caption: Caption | null) {
    this.director = { ...this.director, room, caption, seq: this.director.seq + 1 };
    this.emit('director');
  }

  setCaption(caption: Caption) {
    const c = this.director.caption;
    if (c && c.key === caption.key && JSON.stringify(c.params) === JSON.stringify(caption.params)) return;
    this.director = { ...this.director, caption };
    this.emit('director');
  }

  setStats(s: SceneStats) {
    this.stats = s;
    this.emit('stats');
  }
}

export const controller = new MapController();

export function usePanel(): Panel {
  return useSyncExternalStore(
    useCallback((l: Listener) => controller.subscribe('panel', l), []),
    () => controller.panel,
  );
}

export function useDirector(): DirectorUi {
  return useSyncExternalStore(
    useCallback((l: Listener) => controller.subscribe('director', l), []),
    () => controller.director,
  );
}

export function useFollow(): string | null {
  return useSyncExternalStore(
    useCallback((l: Listener) => controller.subscribe('follow', l), []),
    () => controller.follow,
  );
}

export function useStats(): SceneStats {
  return useSyncExternalStore(
    useCallback((l: Listener) => controller.subscribe('stats', l), []),
    () => controller.stats,
  );
}
