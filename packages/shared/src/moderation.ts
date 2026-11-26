/**
 * Small multilingual word filter for names and messages. Intentionally conservative: it masks slurs and the
 * most common profanity. Admins can extend it at runtime with `addBlockedWords`.
 * Words are stored lowercased and matched on word-ish boundaries (or as substrings for CJK).
 */
const BASE_WORDS: string[] = [
  // en
  'fuck', 'fucking', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut', 'rapist', 'nazi',
  'hitler', 'kike', 'spic', 'chink', 'tranny', 'pedo', 'pedophile',
  // pt-BR
  'caralho', 'porra', 'buceta', 'viado', 'arrombado', 'puta', 'fdp', 'cuzão', 'merda', 'macaco imundo',
  // es
  'mierda', 'puto', 'maricón', 'gilipollas', 'coño', 'pendejo', 'culero',
  // fr
  'putain', 'connard', 'salope', 'enculé', 'pédé', 'nègre',
  // zh-CN
  '操你', '傻逼', '妈的', '他妈', '婊子', '尼哥',
  // ja
  'くそ', 'まんこ', 'ちんこ', '死ね', 'きちがい',
];

const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const words = new Set<string>();
let latinRe: RegExp | null = null;
let cjkList: string[] = [];

function rebuild() {
  const latin: string[] = [];
  cjkList = [];
  for (const w of words) (CJK.test(w) ? cjkList : latin).push(w);
  latin.sort((a, b) => b.length - a.length);
  latinRe = latin.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${latin.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
    : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function addBlockedWords(list: string[]): void {
  for (const w of list) if (w.trim()) words.add(w.trim().toLowerCase());
  rebuild();
}

export function containsBlockedWord(s: string): boolean {
  const lower = s.toLowerCase();
  if (latinRe) {
    latinRe.lastIndex = 0;
    if (latinRe.test(lower)) return true;
  }
  // Names are checked without separators too ("xxfuckxx").
  for (const w of words) if (!CJK.test(w) && w.length >= 5 && lower.includes(w)) return true;
  return cjkList.some((w) => lower.includes(w));
}

/** Masks blocked words with asterisks, preserving everything else. */
export function maskBlockedWords(s: string): string {
  let out = s;
  if (latinRe) out = out.replace(latinRe, (m) => '*'.repeat([...m].length));
  for (const w of cjkList) out = out.split(w).join('*'.repeat([...w].length));
  return out;
}

addBlockedWords(BASE_WORDS);
