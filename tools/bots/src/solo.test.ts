import { describe, expect, it } from 'vitest';
import { randomAppearance } from '@ajwf/appearance';
import { loadContent } from '@ajwf/content/node';
import { apCost, applyAction, checkInvariants, createWorld, registerAgent, tick } from '@ajwf/engine';
import { createRng, type ActionName, type ClassId } from '@ajwf/shared';
import { stepSoloBot } from './solo';

const HOUR = 3_600_000;
/** Seconds an agent takes between two calls (network and thinking). */
const THINK_MS = 3_000;

type Run = { cls: ClassId; level: number; actions: number; ap: number; hours: number; deaths: number; errors: string[] };

/** One bot alone in a fresh world, driven only through `stepSoloBot`, `applyAction` and `tick`. */
function soloRun(cls: ClassId, seed: number, targetLevel = 5, maxSteps = 60_000): Run {
  const content = loadContent();
  const rng = createRng(seed);
  const start = Date.UTC(2026, 0, 5, 9);
  let now = start;
  const s = createWorld(content, now);
  const reg = registerAgent(s, { name: `Solo_${cls}`, cls, lang: 'en', appearance: randomAppearance(createRng(seed)), claimed: true, bot: true }, { now, rng });
  if (!reg.ok) throw new Error(reg.error.code);
  const me = reg.agent;
  const out: Run = { cls, level: 1, actions: 0, ap: 0, hours: 0, deaths: 0, errors: [] };
  for (let i = 0; i < maxSteps && me.level < targetLevel; i++) {
    tick(s, { now, rng });
    const step = stepSoloBot(s, me.id, { now, rng });
    if ('wait' in step) {
      now += step.wait;
      continue;
    }
    const r = applyAction(s, { agentId: me.id, ...step }, { now, rng });
    out.actions++;
    if (r.result.ok) out.ap += apCost(step.action as ActionName);
    else out.errors.push(`${step.action} ${JSON.stringify(step.params)}: ${r.result.error.code} ${r.result.error.msg.k}`);
    out.deaths += r.events.filter((e) => e.type === 'fallen' && e.actor === me.id).length;
    now += THINK_MS;
  }
  out.level = me.level;
  out.hours = (now - start) / HOUR;
  expect(checkInvariants(s, now)).toEqual([]);
  return out;
}

describe('solo bot (M1 acceptance: level 1 to 5 only through applyAction)', () => {
  for (const cls of ['warrior', 'mage', 'rogue', 'cleric'] as const) {
    it(`a ${cls} reaches level 5`, () => {
      const r = soloRun(cls, 11);
      console.log(
        `${cls.padEnd(7)} level ${r.level}: ${r.actions} actions, ${r.ap} AP spent, ${r.hours.toFixed(1)} simulated hours, ${r.deaths} deaths, ${r.errors.length} refused`,
      );
      expect(r.level).toBe(5);
      // About three days of solo play at most (PLANEJAMENTO §5.1: level 10 in ~3 days when social, twice that alone).
      expect(r.hours).toBeLessThan(72);
      // A sensible bot is rarely told no.
      expect(r.errors.length, r.errors.slice(0, 5).join('\n')).toBeLessThan(Math.max(5, r.actions * 0.01));
    });
  }
});
