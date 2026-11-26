/** A source of spectator messages: the real WebSocket server or the in-browser mock simulation. */

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export type SourceHandlers = {
  /** A decoded server message (still untrusted: the store validates it). */
  message(msg: unknown): void;
  status(s: ConnStatus): void;
};

export interface DataSource {
  readonly kind: 'ws' | 'mock';
  connect(handlers: SourceHandlers): void;
  /** The full set of topics wanted now; the source diffs, subscribes and resubscribes after reconnecting. */
  setTopics(topics: readonly string[]): void;
  close(): void;
  /** GET a public JSON endpoint (`/api/public/...`). Null on any failure. */
  getJson(path: string): Promise<unknown>;
  /** The 80x28 sheet (4 frames of 20x28) of an agent appearance hash. */
  spriteImage(hash: string): Promise<CanvasImageSource | null>;
  /** The 80x28 sheet of an NPC. */
  npcSpriteImage(id: string): Promise<CanvasImageSource | null>;
}

const SPRITE_HASH = /^[0-9a-f]{6,64}$/;
const NPC_ID = /^[a-z0-9_]{1,64}$/;

export function loadImage(url: string): Promise<CanvasImageSource | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Sprite URLs are built only from validated ids: server strings never become arbitrary URLs. */
export function spriteUrl(hash: string): string | null {
  return SPRITE_HASH.test(hash) ? `/sprites/${hash}.png` : null;
}

export function npcSpriteUrl(id: string): string | null {
  return NPC_ID.test(id) ? `/sprites/npc/${id}.png` : null;
}

export async function getJson(path: string): Promise<unknown> {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Reconnect delay: exponential with jitter, 0.5 s up to 15 s. */
export function backoffMs(attempt: number, rand = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.75 + rand() * 0.5));
}
