/**
 * UI-facing state of the live map, outside React: the open panel, director mode, follow, debug stats. The Pixi scene
 * writes it and registers its commands; React reads it through the hooks below.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Reason } from '../data/scout';
import type { Activity } from '../view/activity';
import type { Caption } from './director';

export type Panel = { kind: 'room'; id: string } | { kind: 'agent'; name: string } | null;

/**
 * Director state shown by React. `star` is the agent the camera follows (null during a special moment or before one is
 * chosen); `seq` changes only on a new shot (a change of star or a special moment), so the caption slides in again
 * only then, while refreshes of the same shot keep it in place.
 */
export type DirectorUi = {
  enabled: boolean;
  star: string | null;
  room: string | null;
  caption: Caption | null;
  seq: number;
};

/** The director's star for the star card: what they are doing now, their last actions, and why we follow them. */
export type StarView = { star: string | null; now: Activity | null; recent: Activity[]; why: Reason | null };

/** `?debug=1`: what the director is thinking (star, top interests, broadcast lag, rooms the scout holds). */
export type DirectorDebug = {
  star: string | null;
  top: [string, number][];
  lagMs: number;
  scoutRooms: number;
};

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
  director: DirectorUi = { enabled: true, star: null, room: null, caption: null, seq: 0 };
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
  directorDebug: DirectorDebug = { star: null, top: [], lagMs: 0, scoutRooms: 0 };
  starView: StarView = { star: null, now: null, recent: [], why: null };
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

  /** A new shot: a change of star, or a special moment (`star` null). */
  setDirectorShot(star: string | null, room: string, caption: Caption | null) {
    this.director = { ...this.director, star, room, caption, seq: this.director.seq + 1 };
    this.emit('director');
  }

  /** The same shot, refreshed: the star changed room or did something notable. */
  updateDirectorShot(room: string, caption: Caption) {
    const d = this.director;
    const c = d.caption;
    if (d.room === room && c && c.key === caption.key && JSON.stringify(c.params) === JSON.stringify(caption.params))
      return;
    this.director = { ...d, room, caption };
    this.emit('director');
  }

  setStarView(v: StarView) {
    const a = this.starView;
    if (
      a.star === v.star &&
      a.why === v.why &&
      JSON.stringify([a.now, a.recent]) === JSON.stringify([v.now, v.recent])
    )
      return;
    this.starView = v;
    this.emit('starView');
  }

  setDirectorDebug(d: DirectorDebug) {
    this.directorDebug = d;
    this.emit('directorDebug');
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

export function useDirectorDebug(): DirectorDebug {
  return useSyncExternalStore(
    useCallback((l: Listener) => controller.subscribe('directorDebug', l), []),
    () => controller.directorDebug,
  );
}

export function useStarView(): StarView {
  return useSyncExternalStore(
    useCallback((l: Listener) => controller.subscribe('starView', l), []),
    () => controller.starView,
  );
}
