import { CoreFault, FAULT } from './errors.ts';

/**
 * Validates a user-entered base URL (a game server, or an AI server on the home network): http or https only, no
 * credentials, no query or fragment. Returns it without a trailing slash.
 */
export function normalizeBaseUrl(input: string, what = 'URL'): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CoreFault(FAULT.invalidUrl, `The ${what} is not a valid address.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CoreFault(FAULT.invalidUrl, `The ${what} must start with http:// or https://.`);
  if (u.username || u.password) throw new CoreFault(FAULT.invalidUrl, `The ${what} must not contain a user name or password.`);
  if (u.search || u.hash) throw new CoreFault(FAULT.invalidUrl, `The ${what} must not contain a query or a fragment.`);
  if (!u.hostname) throw new CoreFault(FAULT.invalidUrl, `The ${what} has no host.`);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return originOf(a) === originOf(b);
  } catch {
    return false;
  }
}
