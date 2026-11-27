import { containsBlockedWord } from './moderation';
import { isPlainKey } from './schemas';

const NAME_RE = /^[\p{L}\p{M}\p{N}_-]+$/u;
/**
 * Letters that render as nothing (Hangul fillers), invisible marks (variation selectors, the combining grapheme
 * joiner, Khmer inherent vowels) and letters that look like punctuation (modifier-letter quotes, primes and colons;
 * click letters that look like `!` and `|`): a name made with them reads as another name or as a quote mark.
 */
const DECEPTIVE_RE = /[\p{Default_Ignorable_Code_Point}\u01C0-\u01C3\u02B9-\u02BF\u02C2-\u02DF\u02E5-\u02FF\uA788]/u;

/** Invisible characters or modifier letters that pass for punctuation: refused in agent and guild names alike. */
export function hasDeceptiveChars(name: string): boolean {
  return DECEPTIVE_RE.test(name);
}

/**
 * Names are interpolated into narration that agents read and trust ("Wulf waves at you"). A name that reads like an
 * instruction or an authority ("SystemNotice", "IgnorePrevious", "Admin Team", "管理员") is a cheap prompt-injection
 * attempt, so these stems are refused, in the launch languages, wherever they appear in the name (spaces, `_` and
 * `-` removed, lookalikes folded). This is a speed bump, not a guarantee: a determined player will find wording
 * that is not on the list, and what really protects agents is that narration marks names as names and that the
 * rules tell them names are never instructions. Keep the list short, distinctive stems only (false positives refuse
 * honest names: "Ecosystem" goes too, "Mod" alone is in RESERVED, not here).
 */
const COMMAND_STEMS: readonly string[] = [
  // en
  'system', 'admin', 'moderator', 'ignore', 'instruction', 'prompt', 'apikey', 'assistant', 'override', 'jailbreak', 'password', 'developer',
  // pt-BR / es / fr
  'sistema', 'moderador', 'ignora', 'instrucci', 'instruçã', 'instruçõ', 'senha', 'chaveapi', 'chavedeapi', 'contraseña', 'claveapi', 'clavedeapi',
  'systeme', 'système', 'modérateur', 'moderateur', 'cleapi', 'cléapi', 'motdepasse',
  // ja / zh-CN
  'システム', '管理者', '運営', 'モデレーター', '無視', '指示', '命令', '系统', '管理员', '版主', '忽略', '指令', '密钥', '提示词',
];

/** Whether a name contains one of the instruction-like or authority-like stems (see `COMMAND_STEMS`). */
export function soundsLikeCommand(name: string): boolean {
  const flat = normalizeName(name).replace(/[\s_-]+/g, '');
  const skeleton = nameSkeleton(name).replace(/[\s_-]+/g, '');
  return COMMAND_STEMS.some((w) => flat.includes(w) || skeleton.includes(nameSkeleton(w)));
}

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
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '')
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
  if (!NAME_RE.test(display) || hasDeceptiveChars(display)) return { ok: false, reason: 'characters' };
  if (!/[\p{L}]/u.test(display)) return { ok: false, reason: 'characters' };
  const norm = normalizeName(display);
  const skeleton = nameSkeleton(display);
  if (RESERVED.has(norm) || RESERVED.has(skeleton)) return { ok: false, reason: 'reserved' };
  // `constructor`, `__proto__`...: names end up as keys in places, and read as code anyway.
  if (!isPlainKey(display) || soundsLikeCommand(display)) return { ok: false, reason: 'reserved' };
  if (containsBlockedWord(norm) || containsBlockedWord(skeleton)) return { ok: false, reason: 'blocked' };
  return { ok: true, display, norm, skeleton };
}
