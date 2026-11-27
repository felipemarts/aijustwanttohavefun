import { FRAME_H, FRAME_W } from '@ajwf/appearance/sprite';
import { describe, expect, it } from 'vitest';
import { agentLayout, CARD_H, CARD_W, drawCard, LABEL_SCALE, LINE_SCALE, oneLine } from './cards';
import { cardFont } from './font';
import { PNG_SIGNATURE, textWidth } from './raster';

const font = cardFont();
const portrait = { width: FRAME_W, height: FRAME_H, rgba: new Uint8Array(FRAME_W * FRAME_H * 4) };
/** Width in font pixels of a Latin letter and of a CJK character. */
const LATIN = 8;
const CJK = 16;

describe('agent share card layout', () => {
  it('has the room owner.yaml promises translators: 28 Latin letters (14 CJK) for level_class, 12 (6) for stat labels', () => {
    const L = agentLayout(portrait, 3);
    expect(Math.floor(L.maxW / (LATIN * LINE_SCALE))).toBeGreaterThanOrEqual(28);
    expect(Math.floor(L.maxW / (CJK * LINE_SCALE))).toBeGreaterThanOrEqual(14);
    expect(Math.floor(L.labelW / (LATIN * LABEL_SCALE))).toBeGreaterThanOrEqual(12);
    expect(Math.floor(L.labelW / (CJK * LABEL_SCALE))).toBeGreaterThanOrEqual(6);
    expect(L.x + L.maxW).toBeLessThanOrEqual(CARD_W);
  });

  it('cuts a level and class line that is too long with an ellipsis instead of overflowing', () => {
    const { maxW } = agentLayout(portrait, 3);
    for (const line of ['Level 20 Extraordinarily Long Class Name Indeed', 'レベル20 とてもとてもとても長い職業の名前です']) {
      expect(textWidth(font, line, LINE_SCALE)).toBeGreaterThan(maxW);
      const cut = oneLine(font, line, LINE_SCALE, maxW);
      expect(cut.endsWith('…')).toBe(true);
      expect(textWidth(font, cut, LINE_SCALE)).toBeLessThanOrEqual(maxW);
    }
    expect(oneLine(font, 'Level 20 Warrior', LINE_SCALE, maxW)).toBe('Level 20 Warrior');
    const png = drawCard(font, {
      kind: 'agent',
      name: 'Pip',
      line: 'Level 20 Extraordinarily Long Class Name Indeed',
      stats: [
        { label: 'Achievements and many more words', value: '12' },
        { label: 'Friends', value: '3' },
        { label: 'Days here', value: '9' },
      ],
      portrait,
      footer: 'AI Just Want to Have Fun',
      site: 'example.test',
    });
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(CARD_W);
    expect(png.readUInt32BE(20)).toBe(CARD_H);
  });
});
