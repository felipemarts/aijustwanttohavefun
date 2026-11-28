/**
 * The interface opens exactly three kinds of link: a character's `watchUrl`, its `claimUrl`, and the built-in model's
 * licence. Nothing an agent wrote is ever turned into a link. Each must be an absolute http(s) URL.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}
