/** The playkit's data (playkit.json and the templates) as the port uses it. Go: `internal/playkit/kit.go`. */
import { PLAYKIT_JSON, TEMPLATES } from './kit-data.ts';
import { at, text, type JV } from './jv.ts';

export type PaceName = 'relaxed' | 'normal' | 'active';

export type Config = {
  version: string;
  decision: { thoughtMax: number; noteMax: number; textMax: number; rawMax: number; forbiddenKeys: string[]; forbiddenText: string[] };
  excludedActions: string[];
  alwaysOffered: string[];
  omitParams: { action: string; param: string }[];
  pvpActions: string[];
  supportiveSkillTargets: string[];
  narrow: { action: string; param: string; from: string; pvpFrom?: string }[];
  fallbackActions: string[];
  stepHints: Record<string, string>;
  limits: Record<string, number>;
  refreshMeAfter: string[];
  wakeKinds: string[];
  wakeOnName: string[];
  pace: Record<PaceName, { sessionTurns: number; gapSeconds: number; pollSeconds: number }>;
  ap: { stopBelow: number; resumeAt: number; regenSeconds: number };
  requests: { perMinute: number; turnGapMs: number; cooldownWaitSeconds: number; maxRetryAfterSeconds: number };
  sampling: { temperature: number; topK: number; repeatPenalty: number; maxTokens: number; chatMaxTokens: number };
  languages: Record<string, string>;
};

export type TemplateName = 'system' | 'turn' | 'retry' | 'chat' | 'compact';

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export class Kit {
  readonly config: Config;
  readonly templates: Record<TemplateName, string>;

  constructor(config: Config = JSON.parse(PLAYKIT_JSON) as Config, templates: Record<string, string> = TEMPLATES) {
    this.config = config;
    const t = {} as Record<TemplateName, string>;
    for (const name of ['system', 'turn', 'retry', 'chat', 'compact'] as const) {
      const tpl = templates[name];
      if (typeof tpl !== 'string') throw new Error(`playkit: missing template ${name}`);
      t[name] = tpl.replace(/\r\n/g, '\n');
    }
    this.templates = t;
  }

  get version(): string {
    return this.config.version;
  }

  /** A limit from playkit.json; a missing one is a programming error. */
  lim(name: string): number {
    if (!own(this.config.limits, name)) throw new Error(`playkit: unknown limit ${name}`);
    return this.config.limits[name]!;
  }

  /** The table entry for the tag, else for its primary subtag, else the tag itself. */
  languageName(tag: string): string {
    const l = this.config.languages;
    if (own(l, tag)) return l[tag]!;
    const primary = tag.split('-')[0]!;
    return own(l, primary) ? l[primary]! : tag;
  }

  /** README 6.4: a kind in wakeKinds, or in wakeOnName with the character's name in its text (lower-cased). */
  wakes(event: JV, name: string): boolean {
    const kind = text(at(event, 'kind'));
    if (this.config.wakeKinds.includes(kind)) return true;
    if (this.config.wakeOnName.includes(kind) && name !== '') return text(at(event, 'untrusted_text')).toLowerCase().includes(name.toLowerCase());
    return false;
  }

  refreshesMe(action: string): boolean {
    return this.config.refreshMeAfter.includes(action);
  }
}
