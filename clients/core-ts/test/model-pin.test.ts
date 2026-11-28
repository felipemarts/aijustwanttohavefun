import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL, isPinned } from '../src/engine/model.ts';
import { Kit } from '../src/playkit/kit.ts';

/** The desktop core's pins: both clients must download the same file. */
const pins = readFileSync(new URL('../../desktop/internal/engine/pins.go', import.meta.url), 'utf8');
const goConst = (name: string): string => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|(\\d+))`).exec(pins);
  if (!m) throw new Error(`${name} not found in pins.go`);
  return m[2] ?? m[3]!;
};

describe('built-in model pin', () => {
  it('agrees with clients/desktop/internal/engine/pins.go', () => {
    expect(BUILTIN_MODEL.repo).toBe(goConst('ModelRepo'));
    expect(BUILTIN_MODEL.revision).toBe(goConst('ModelRevision'));
    expect(BUILTIN_MODEL.file).toBe(goConst('ModelFile'));
    expect(BUILTIN_MODEL.bytes).toBe(Number(goConst('ModelSize')));
    expect(BUILTIN_MODEL.sha256).toBe(goConst('ModelSHA256'));
    expect(BUILTIN_MODEL.name).toBe(goConst('ModelName'));
    expect(BUILTIN_MODEL.licenseName).toBe(goConst('ModelLicense'));
    expect(BUILTIN_MODEL.licenseUrl).toBe(goConst('ModelLicenseURL'));
    expect(BUILTIN_MODEL.url).toBe(`https://huggingface.co/${goConst('ModelRepo')}/resolve/${goConst('ModelRevision')}/${goConst('ModelFile')}`);
    expect(isPinned(BUILTIN_MODEL)).toBe(true);
  });

  it('runs with the desktop core\'s context and the playkit\'s sampling', () => {
    expect(BUILTIN_MODEL.contextSize).toBe(8192);
    expect(/--ctx-size", "(\d+)"/.exec(readFileSync(new URL('../../desktop/internal/engine/builtin.go', import.meta.url), 'utf8'))?.[1]).toBe('8192');
    const s = new Kit().config.sampling;
    expect([s.temperature, s.topK, s.repeatPenalty]).toEqual([0.1, 50, 1.1]);
  });
});
