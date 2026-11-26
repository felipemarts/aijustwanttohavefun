import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appearanceHash, randomAppearance, type Appearance } from '@ajwf/appearance';
import { renderSpritePng } from '@ajwf/appearance/sprite';
import type { WorldState } from '@ajwf/engine';
import { createRng, hashString, type GameEvent } from '@ajwf/shared';
import type { Logger } from 'pino';
import type { EventConsumer } from './game';
import { Lru } from './lru';

export const LOOK_HASH_RE = /^[0-9a-f]{14}$/;
export const NPC_ID_RE = /^[a-z0-9_]{1,64}$/;

/** NPCs have no art: each one wears a look drawn from a generator seeded with its id, the same on every server. */
export function npcAppearance(npcId: string): Appearance {
  return randomAppearance(createRng(parseInt(hashString(`npc:${npcId}`).slice(-8), 16)));
}
/** Events after which an agent wears a look that may not have been indexed yet. */
const LOOK_EVENTS = new Set(['arrival', 'look_changed']);

/**
 * Composed sprite sheets by look hash (§5.2). A hash names one exact combination, so a rendered sheet never
 * changes: cached in memory (LRU) and on disk, and served as immutable.
 */
export class SpriteService implements EventConsumer {
  readonly name = 'sprites';
  /** Every look hash ever worn since boot, including looks an agent has since changed. */
  private looks = new Map<string, Appearance>();
  private cache = new Lru<string, Buffer>(2000);

  constructor(
    private state: WorldState,
    private dir: string,
    private log: Logger,
  ) {
    for (const a of state.agents.values()) this.looks.set(a.lookHash, a.appearance);
  }

  consume(events: readonly GameEvent[]): void {
    for (const ev of events) {
      if (!LOOK_EVENTS.has(ev.type) || !ev.actor) continue;
      const a = this.state.agents.get(ev.actor);
      if (a) this.looks.set(a.lookHash, { ...a.appearance });
    }
  }

  /** The sprite sheet of an NPC (deterministic from its id), or null for unknown NPCs. */
  async npcPng(npcId: string): Promise<Buffer | null> {
    if (!NPC_ID_RE.test(npcId) || !this.state.content.npcs.has(npcId)) return null;
    const key = `npc:${npcId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const look = npcAppearance(npcId);
    // Named by look hash like agent sheets: the file always matches the appearance it was drawn from.
    const file = join(this.dir, `${appearanceHash(look)}.png`);
    let png: Buffer | null = await readFile(file).catch(() => null);
    if (!png) {
      png = renderSpritePng(look);
      await this.writeDisk(file, png);
    }
    this.cache.set(key, png);
    return png;
  }

  /** The PNG for a look hash, or null when no agent has ever worn it. */
  async png(hash: string): Promise<Buffer | null> {
    if (!LOOK_HASH_RE.test(hash)) return null;
    const hit = this.cache.get(hash);
    if (hit) return hit;
    const appearance = this.looks.get(hash);
    if (!appearance) return null;
    const file = join(this.dir, `${hash}.png`);
    let png: Buffer | null = await readFile(file).catch(() => null);
    if (!png) {
      png = renderSpritePng(appearance);
      await this.writeDisk(file, png);
    }
    this.cache.set(hash, png);
    return png;
  }

  private async writeDisk(file: string, png: Buffer): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      // Write then rename, so a concurrent reader never sees half a file.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, png);
      await rename(tmp, file);
    } catch (err) {
      this.log.warn({ err }, 'sprite disk cache write failed');
    }
  }
}
