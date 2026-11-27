/**
 * The Village Gazette of a simulated world (PLANEJAMENTO §8.5, M6): the server's pure chronicle code (highlight
 * detector, day tally, gazette builder) fed with the simulation's events, one edition per UTC day, rendered in
 * English so a human can judge whether the paper is worth reading. Mirrors `apps/server/src/civic/chronicle.ts`
 * without its store, rings and timers.
 */
import { villageView, type WorldState } from '@ajwf/engine';
import type { GameEvent, GazetteEdition, Highlight, KeyMsg } from '@ajwf/shared';
import { buildGazette } from '@ajwf/server/src/chronicle/gazette';
import { HighlightDetector, type ChronicleLookup } from '@ajwf/server/src/chronicle/highlights';
import { dailyStats, DayTally, dayKey, goldInCirculation } from '@ajwf/server/src/chronicle/stats';
import { createI18n, loadCatalogs } from '@ajwf/server/src/i18n';
import { isSpectatorVisible } from '@ajwf/server/src/spectate/visibility';

/** One edition as the report shows it: the structured edition plus its English text. */
export type RenderedEdition = {
  date: string;
  final: boolean;
  headline: string;
  sections: { id: string; title: string; items: string[] }[];
  highlights: number;
  /** Titles of the day's highlights, most dramatic first (at most 10). */
  topHighlights: string[];
};

export class SimChronicle {
  readonly editions: RenderedEdition[] = [];
  readonly highlightCounts: Record<string, number> = {};
  private detector: HighlightDetector;
  private tally: DayTally | null = null;
  private dayHighlights: Highlight[] = [];
  private actors = new Set<string>();
  private i18n = createI18n(loadCatalogs(), (id) => this.s.agents.get(id)?.name);

  constructor(
    private s: WorldState,
    private seed: number,
  ) {
    const look: ChronicleLookup = {
      agentName: (id) => s.agents.get(id)?.name,
      monsterKind: (id) => {
        const m = s.content.monsters.get(id);
        return m ? (m.world_boss ? 'world_boss' : m.boss ? 'boss' : 'normal') : undefined;
      },
    };
    this.detector = new HighlightDetector(look);
  }

  /** Public events only, as the server's chronicle sees them; a new UTC day publishes the previous one. */
  consume(events: readonly GameEvent[]): void {
    for (const ev of events) {
      if (ev.visibility === 'delayed' || !isSpectatorVisible(ev)) continue;
      const date = dayKey(ev.ts);
      if (!this.tally) this.tally = new DayTally(date);
      if (date !== this.tally.date) this.publish(ev.ts, true, date);
      this.tally.consume(ev, (id) => this.s.agents.get(id)?.name);
      if (ev.actor) this.actors.add(ev.actor);
      for (const h of this.detector.detect(ev)) {
        this.dayHighlights.push(h);
        this.highlightCounts[h.type] = (this.highlightCounts[h.type] ?? 0) + 1;
      }
    }
  }

  /** The running day's edition (not final), at the end of a run. */
  finish(now: number): void {
    if (this.tally) this.publish(now, false, null);
  }

  private publish(now: number, final: boolean, next: string | null): void {
    const t = this.tally!;
    const s = this.s;
    const edition = buildGazette({
      date: t.date,
      seed: this.seed,
      templates: s.content.gazetteTemplates,
      highlights: this.dayHighlights,
      village: villageView(s, now),
      stats: dailyStats({
        population: s.agents.size,
        onlinePeak: this.actors.size,
        projectsDone: Object.values(s.village.projects).filter((p) => p.doneAt !== undefined).length,
        goldInCirculation: goldInCirculation(s),
        tally: t,
      }),
      tally: t,
      final,
    });
    this.editions.push(this.render(edition, this.dayHighlights));
    if (next) {
      this.tally = new DayTally(next);
      this.dayHighlights = [];
      this.actors = new Set();
    }
  }

  private text(m: KeyMsg): string {
    return this.i18n.t('en', m.k, m.p);
  }

  private render(e: GazetteEdition, hs: Highlight[]): RenderedEdition {
    return {
      date: e.date,
      final: e.final,
      headline: this.text(e.headline),
      sections: e.sections.map((sec) => ({ id: sec.id, title: this.text({ k: sec.k, p: sec.p }), items: sec.items.map((m) => this.text(m)) })),
      highlights: hs.length,
      topHighlights: [...hs]
        .sort((a, b) => b.drama - a.drama)
        .slice(0, 10)
        .map((h) => this.i18n.t('en', h.titleKey, h.params)),
    };
  }
}
