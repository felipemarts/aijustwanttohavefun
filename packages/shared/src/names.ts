import { containsBlockedWord } from './moderation';

const NAME_RE = /^[\p{L}\p{M}\p{N}_-]+$/u;

/** Lookalike characters folded to a Latin skeleton so "Pip", "Рір" and "P1p" collide. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'l', ї: 'l', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', һ: 'h', ү: 'y', п: 'n', г: 'r',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'l', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  ω: 'w', γ: 'y', ϲ: 'c', ϳ: 'j',
  // Digits and Latin lookalikes
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', i: 'l', ı: 'l', ł: 'l',
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'p',
};

const RESERVED = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'system', 'server', 'root', 'null', 'undefined', 'anonymous',
  'support', 'staff', 'official', 'gamemaster', 'gm', 'dev', 'developer', 'owner', 'mayor', 'guard', 'narrator',
  'ajwf', 'aijustwanttohavefun', 'everyone', 'here', 'you', 'me', 'others', 'nobody', 'someone',
]);

/** Case-insensitive, NFKC-normalized form used for lookups. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().trim();
}

/** Skeleton used to block names that imitate other names with similar characters. */
export function nameSkeleton(name: string): string {
  const base = normalizeName(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[_-]/g, '');
  let out = '';
  for (const ch of base) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/rn/g, 'm').replace(/vv/g, 'w');
}

export type NameCheck = { ok: true; display: string; norm: string; skeleton: string } | { ok: false; reason: string };

export function checkAgentName(raw: string): NameCheck {
  const display = raw.normalize('NFKC').trim();
  const len = [...display].length;
  if (len < 3 || len > 20) return { ok: false, reason: 'length' };
  if (!NAME_RE.test(display)) return { ok: false, reason: 'characters' };
  if (!/[\p{L}]/u.test(display)) return { ok: false, reason: 'characters' };
  const norm = normalizeName(display);
  const skeleton = nameSkeleton(display);
  if (RESERVED.has(norm) || RESERVED.has(skeleton)) return { ok: false, reason: 'reserved' };
  if (containsBlockedWord(norm) || containsBlockedWord(skeleton)) return { ok: false, reason: 'blocked' };
  return { ok: true, display, norm, skeleton };
}
