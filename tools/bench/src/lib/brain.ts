/**
 * What a simulated agent decides, the same in-process (engine scenario) and over HTTP (api scenarios): the live
 * bots' personalities from `tools/bots` (fight, gather, wander, chat) plus a trader, so the mix also covers
 * guaranteed trades. A trader offers a small gift to someone in the room; the bench tells the receiver, which
 * accepts it on its next turn (the receiving agent would read the offer from its inbox).
 */
import type { Content } from '@ajwf/content';
import { decidePersonality, newMemory, type BotMemory, type BotView, type Personality } from '@ajwf/bots';
import { CLASSES, LANGUAGES, type ClassId, type LaunchLanguage, type Rng } from '@ajwf/shared';

export type Role = Personality | 'trader';

/** Share of each role in the crowd: mostly fighting and gathering, as a live population would be. */
const ROLES: [Role, number][] = [
  ['fighter', 0.3],
  ['gatherer', 0.25],
  ['wanderer', 0.15],
  ['chatterbox', 0.15],
  ['trader', 0.15],
];

export type Step = { action: string; params: Record<string, unknown> } | { wait: number };

export class Brain {
  readonly mem: BotMemory = newMemory();
  /** Trade offers made to this agent that it will accept on its next turn. */
  readonly offers: string[] = [];
  lastOfferAt = -Infinity;

  constructor(
    readonly name: string,
    readonly role: Role,
    readonly lang: LaunchLanguage,
    readonly cls: ClassId,
    readonly rng: Rng,
  ) {}

  static make(name: string, rng: Rng): Brain {
    let x = rng.next();
    let role: Role = 'fighter';
    for (const [r, share] of ROLES) {
      if (x < share) {
        role = r;
        break;
      }
      x -= share;
    }
    return new Brain(name, role, rng.pick(LANGUAGES), rng.pick(CLASSES), rng);
  }

  decide(c: Content, view: BotView, now: number): Step {
    const me = view.obs.you;
    const free = me.fallen === undefined && !me.in_combat;
    const offer = this.offers.shift();
    if (offer && free) return { action: 'trade_accept', params: { trade: offer } };
    if (this.role === 'trader' && free && now - this.lastOfferAt > 20_000) {
      const others = view.obs.room.agents.filter((a) => a.name !== this.name);
      if (others.length && me.gold >= 2 && this.rng.chance(0.6)) {
        this.lastOfferAt = now;
        return { action: 'trade_offer', params: { to: this.rng.pick(others).name, give: { gold: 1 }, want: {} } };
      }
    }
    const p: Personality = this.role === 'trader' ? 'chatterbox' : this.role;
    return decidePersonality(p, view, { c, rng: this.rng, now, lang: this.lang, mem: this.mem });
  }
}

/** Counts by action and by refusal code, for the report. */
export class Mix {
  readonly byAction: Record<string, number> = {};
  readonly refused: Record<string, number> = {};
  ok = 0;
  total = 0;

  add(action: string, refusal: string | null): void {
    this.total++;
    this.byAction[action] = (this.byAction[action] ?? 0) + 1;
    if (refusal) this.refused[refusal] = (this.refused[refusal] ?? 0) + 1;
    else this.ok++;
  }

  /** Shares of the total, rounded, largest first. */
  shares(): Record<string, number> {
    return Object.fromEntries(
      Object.entries(this.byAction)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [k, Math.round((n / Math.max(1, this.total)) * 1000) / 1000]),
    );
  }
}
