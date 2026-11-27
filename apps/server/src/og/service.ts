import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FRAME_H, FRAME_W, portraitRgba } from '@ajwf/appearance/sprite';
import type { AgentState } from '@ajwf/engine';
import type { Highlight } from '@ajwf/shared';
import type { Logger } from 'pino';
import type { Chronicle } from '../civic/chronicle';
import type { Game } from '../game';
import { Lru } from '../lru';
import type { Renderer } from '../render';
import { drawCard, type CardData, type Picture } from './cards';
import { cardFont } from './font';

const DAY_MS = 24 * 3_600_000;

export type Card = { png: Buffer; hash: string };

/** A card's inputs (the portraits by look hash) say everything about its pixels: their hash names the image. */
type Spec = { data: CardData; looks: string[] };

function hashOf(spec: Spec): string {
  const replacer = (k: string, v: unknown) => (k === 'portrait' || k === 'portraits' ? undefined : v);
  return createHash('sha256').update(JSON.stringify(spec.data, replacer)).update(spec.looks.join(',')).digest('hex').slice(0, 24);
}

const portrait = (a: AgentState): Picture => ({ width: FRAME_W, height: FRAME_H, rgba: portraitRgba(a.appearance) });

/**
 * Share cards (§14.2): 1200x630 PNGs for agents, highlights and gazette editions, in any launch language. Composed
 * on demand from current data, cached by content hash in memory and on disk, so a card is drawn once per change.
 */
export class CardService {
  private cache = new Lru<string, Buffer>(300);
  private readonly site: string;

  constructor(
    private game: Game,
    private render: Renderer,
    private chronicle: Chronicle,
    publicUrl: string,
    private dir: string,
    private log: Logger,
  ) {
    this.site = new URL(publicUrl).host;
  }

  private common(lang: string) {
    return { footer: this.render.t(lang, 'owner.card.game_name'), site: this.site };
  }

  private date(lang: string, ts: number, style: 'long' | 'full' = 'long'): string {
    try {
      return new Intl.DateTimeFormat(lang, { dateStyle: style, timeZone: 'UTC' }).format(ts);
    } catch {
      return new Date(ts).toISOString().slice(0, 10);
    }
  }

  agentSpec(a: AgentState, lang: string): Spec {
    const t = (k: string, p?: Record<string, string | number>) => this.render.t(lang, k, p);
    const days = Math.max(1, Math.floor((this.game.now() - a.createdAt) / DAY_MS) + 1);
    return {
      looks: [a.lookHash],
      data: {
        kind: 'agent',
        name: a.name,
        ...(a.title ? { title: this.render.name(lang, 'title', a.title) } : {}),
        line: t('owner.card.level_class', { level: a.level, class: `@class:${a.cls}` }),
        stats: [
          { label: t('owner.card.achievements'), value: String(Object.keys(a.achievements).length) },
          { label: t('owner.card.friends'), value: String(a.friends.length) },
          { label: t('owner.card.days', { n: days }), value: String(days) },
        ],
        portrait: portrait(a),
        ...this.common(lang),
      },
    };
  }

  highlightSpec(h: Highlight, lang: string): Spec {
    const agents = h.agents.flatMap((n) => this.game.agentByName(n) ?? []).slice(0, 3);
    return {
      looks: agents.map((a) => a.lookHash),
      data: {
        kind: 'highlight',
        label: this.render.t(lang, 'owner.card.highlight'),
        title: this.render.t(lang, h.titleKey, h.params),
        date: this.date(lang, h.ts),
        portraits: agents.map(portrait),
        ...this.common(lang),
      },
    };
  }

  /** Null when the edition does not exist. */
  async gazetteSpec(date: string, lang: string): Promise<{ spec: Spec; final: boolean } | null> {
    const e = await this.chronicle.edition(date);
    if (!e) return null;
    return {
      final: e.final,
      spec: {
        looks: [],
        data: {
          kind: 'gazette',
          masthead: this.render.t(lang, 'owner.card.gazette'),
          date: this.date(lang, Date.parse(`${e.date}T12:00:00Z`), 'full'),
          headline: this.render.t(lang, e.headline.k, e.headline.p),
          ...this.common(lang),
        },
      },
    };
  }

  /** The version string of a spec, for `?v=` in share URLs (a changed card gets a new URL). */
  version(spec: Spec): string {
    return hashOf(spec);
  }

  async png(spec: Spec): Promise<Card> {
    const hash = hashOf(spec);
    const hit = this.cache.get(hash);
    if (hit) return { png: hit, hash };
    const file = join(this.dir, `${hash}.png`);
    let png: Buffer | null = await readFile(file).catch(() => null);
    if (!png) {
      png = drawCard(cardFont(), spec.data);
      await this.writeDisk(file, png);
    }
    this.cache.set(hash, png);
    return { png, hash };
  }

  private async writeDisk(file: string, png: Buffer): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, png);
      await rename(tmp, file);
    } catch (err) {
      this.log.warn({ err }, 'share card disk cache write failed');
    }
  }
}
