import type { SpectatorEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { Translator } from '../i18n/translator';
import { loadCatalog } from '../test/fixtures';
import type { Activity } from './activity';
import { bannerItem, eventItems, introItem, isNotable, NowNarrator } from './narration';
import { PRIORITY, SPEECH } from './speech';

const en = loadCatalog('en');
const pt = loadCatalog('pt-BR');
const trEn = new Translator('en', en, en);
const trPt = new Translator('pt-BR', pt, en);

let seq = 0;
const ev = (e: Partial<SpectatorEvent>): SpectatorEvent => ({
  id: String(++seq),
  ts: 1_000,
  type: 'say',
  room: 'village.square',
  ...e,
});
const ctx = {
  star: 'Pip',
  room: 'village.square',
  clsOf: (n: string) => (n === 'Pip' ? 'rogue' : 'warrior'),
};

const act = (
  key: string,
  tone: Activity['tone'],
  ts: number,
  params: Record<string, string | number> = {},
): Activity => ({
  key,
  params,
  icon: 'star',
  tone,
  quote: null,
  target: null,
  ts,
});

describe('what becomes speech', () => {
  it('speaks the star and the others in the star room, each in their own voice', () => {
    const items = eventItems(
      trEn,
      [
        ev({ actor: 'Pip', lang: 'en', text: 'Anyone up for the mines?' }),
        ev({ actor: 'Bram', lang: 'pt-BR', text: 'Eu vou!' }),
        ev({ actor: 'Odessa', lang: 'en', text: 'Too far.', room: 'forest.glade' }),
      ],
      ctx,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      priority: PRIORITY.starSay,
      lines: [{ speaker: 'Pip', lang: 'en', cls: 'rogue', text: 'Anyone up for the mines?' }],
    });
    expect(items[1]).toMatchObject({
      priority: PRIORITY.roomSay,
      lines: [{ speaker: 'Bram', lang: 'pt-BR', cls: 'warrior' }],
    });
  });

  it('skips speech in any other language, or with no language at all, silently', () => {
    const items = eventItems(
      trEn,
      [
        ev({ actor: 'Pip', lang: 'es', text: '¿Alguien quiere ir a las ruinas?' }),
        ev({ actor: 'Pip', lang: 'ja', text: '遺跡は危ないよ。' }),
        ev({ actor: 'Pip', lang: 'zh-CN', text: '需要一个牧师！' }),
        ev({ actor: 'Pip', text: 'No tag' }),
        ev({ actor: 'Pip', lang: '<en>', text: 'Bad tag' }),
        ev({ actor: 'Pip', lang: 'en', text: '   ' }),
      ],
      ctx,
    );
    expect(items).toEqual([]);
  });

  it('passes agent text as plain text, markup removed, capped', () => {
    const [it0] = eventItems(
      trEn,
      [ev({ actor: 'Pip', lang: 'en', text: `<b>free loot</b> at the square ${'and more '.repeat(40)}` })],
      ctx,
    );
    const text = it0!.lines[0]!.text;
    expect(text.startsWith('free loot at the square')).toBe(true);
    expect(text).not.toMatch(/[<>]/);
    expect(text.length).toBeLessThanOrEqual(SPEECH.maxChars);
  });

  it('reads a wish: the narrator says the now line, then the star reads the wish', () => {
    const [w] = eventItems(
      trPt,
      [ev({ type: 'wish', actor: 'Pip', lang: 'en', text: 'More snacks at the tavern.' })],
      ctx,
    );
    expect(w!.priority).toBe(PRIORITY.wish);
    expect(w!.lines).toEqual([
      { text: `Pip: ${pt['ui.director.now.wish']}`, lang: 'pt-BR', speaker: null },
      { text: 'More snacks at the tavern.', lang: 'en', speaker: 'Pip', cls: 'rogue' },
    ]);
    // a wish in another language: the narration only
    const [fr] = eventItems(
      trEn,
      [ev({ type: 'wish', actor: 'Pip', lang: 'fr', text: 'Je souhaite un ami.' })],
      ctx,
    );
    expect(fr!.lines).toHaveLength(1);
    expect(fr!.lines[0]!.speaker).toBeNull();
    // someone else's wish is not the star's story
    expect(eventItems(trEn, [ev({ type: 'wish', actor: 'Bram', lang: 'en', text: 'Gold' })], ctx)).toEqual(
      [],
    );
  });

  it('introduces a new star in one short line, in the interface language', () => {
    const e = introItem(trEn, { name: 'Pip', cls: 'warrior', level: 4, room: 'village.square' })!;
    expect(e.priority).toBe(PRIORITY.intro);
    expect(e.lines[0]!.lang).toBe('en');
    const text = e.lines[0]!.text;
    expect(text).toContain('Pip');
    expect(text).toContain(en['content.class.warrior.name']!);
    expect(text).toContain('4');
    expect(text).toContain(en['content.room.village.square.name']!);
    expect(text).not.toContain('@');
    const p = introItem(trPt, { name: 'Pip', cls: 'warrior', level: 4, room: 'village.square' })!.lines[0]!;
    expect(p.lang).toBe('pt-BR');
    expect(p.text).toContain(pt['content.class.warrior.name']!);
    expect(p.text).toContain(pt['content.room.village.square.name']!);
  });

  it('reads a big-moment banner as a big narration', () => {
    const b = bannerItem(trEn, 'pvp_kill', { actor: 'Pip', name: 'Bram' }, 'x')!;
    expect(b).toMatchObject({
      big: true,
      priority: PRIORITY.banner,
      lines: [{ speaker: null, big: true, text: 'Pip defeats Bram!' }],
    });
  });
});

describe('the now narrator', () => {
  it('never narrates routine lines, and not the line a new star already has', () => {
    const n = new NowNarrator();
    expect(n.update(trEn, 'Pip', act('level_up', 'gold', 1, { level: 3 }), 0)).toBeNull(); // baseline
    expect(n.update(trEn, 'Pip', act('move', 'plain', 2, { room: '@room:village.square' }), 100)).toBeNull();
    expect(n.update(trEn, 'Pip', act('gather', 'plain', 3, { item: '@item:wood' }), 200)).toBeNull();
    expect(n.update(trEn, 'Pip', act('idle', 'plain', 4, { room: '@room:village.square' }), 300)).toBeNull();
    expect(n.update(trEn, 'Pip', act('say', 'teal', 5), 400)).toBeNull();
    const up = n.update(trEn, 'Pip', act('level_up', 'gold', 6, { level: 4 }), 500)!;
    expect(up.priority).toBe(PRIORITY.now);
    expect(up.lines[0]!.text).toBe('Pip: Reaches level 4!');
  });

  it('narrates notable lines at most once every 8 seconds, and not the same line twice in 20', () => {
    const n = new NowNarrator();
    n.update(trEn, 'Pip', null, 0);
    n.update(trEn, 'Pip', act('idle', 'plain', 1), 0);
    expect(n.update(trEn, 'Pip', act('attacked', 'danger', 2, { name: 'Bram' }), 1_000)).not.toBeNull();
    expect(n.update(trEn, 'Pip', act('trade', 'teal', 3, { name: 'Bram' }), 5_000)).toBeNull();
    expect(n.update(trEn, 'Pip', act('attacked', 'danger', 4, { name: 'Bram' }), 12_000)).toBeNull();
    expect(n.update(trEn, 'Pip', act('party_form', 'teal', 5, { name: 'Odessa' }), 13_000)).not.toBeNull();
    expect(n.update(trEn, 'Pip', act('attacked', 'danger', 6, { name: 'Bram' }), 30_000)).not.toBeNull();
  });

  it('leaves a moment the banner already read, and starts over for a new star', () => {
    const n = new NowNarrator();
    n.update(trEn, 'Pip', act('idle', 'plain', 1), 0);
    n.markBanner(2);
    expect(n.update(trEn, 'Pip', act('fallen', 'danger', 2), 1_000)).toBeNull();
    n.reset();
    expect(n.update(trEn, 'Bram', act('rare_drop', 'gold', 3, { item: '@item:crystal' }), 20_000)).toBeNull();
    expect(n.update(trEn, 'Bram', act('revive', 'teal', 4, { name: 'Pip' }), 21_000)!.lines[0]!.text).toBe(
      'Bram: Bringing Pip back to life',
    );
  });

  it('knows which lines are notable', () => {
    expect(isNotable(act('robbed', 'danger', 0))).toBe(true);
    expect(isNotable(act('achievement', 'gold', 0))).toBe(true);
    expect(isNotable(act('wandering', 'plain', 0))).toBe(false);
    expect(isNotable(act('craft', 'plain', 0))).toBe(false);
    expect(isNotable(act('wish', 'gold', 0))).toBe(false);
  });
});
