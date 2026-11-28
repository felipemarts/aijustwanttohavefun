/**
 * The desktop program opens the interface at `http://127.0.0.1:<port>/#token=<launch token>`. The fragment never reaches a
 * server; we read it once, keep the token in memory, and rewrite the address bar without it so it does not stay in
 * the history, in bookmarks or on screen.
 */
export type LocationLike = { hash: string; pathname: string; search: string };

export function readToken(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const t = new URLSearchParams(raw).get('token');
  // Tokens are opaque; refuse anything that could not be a header value.
  if (!t || t.length > 512 || !/^[A-Za-z0-9._~+/=-]+$/.test(t)) return null;
  return t;
}

/** Reads the token and scrubs the fragment. Returns null when there is none. */
export function takeSessionToken(loc: LocationLike, replaceUrl: (url: string) => void): string | null {
  const token = readToken(loc.hash);
  if (loc.hash) replaceUrl(loc.pathname + loc.search);
  return token;
}
