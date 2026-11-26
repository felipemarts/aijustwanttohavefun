import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_KEY_PREFIX } from '@ajwf/shared';

const SECRET_BYTES = 32;
/** Prefix plus 32 random bytes in base64url (43 characters). Anything else is rejected before hashing. */
const API_KEY_RE = new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A fresh secret and the hash that is stored instead of it. */
export type Secret = { value: string; hash: string };

export function newApiKey(): Secret {
  const value = API_KEY_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
  return { value, hash: sha256(value) };
}

export function newClaimToken(): Secret {
  const value = randomBytes(SECRET_BYTES).toString('base64url');
  return { value, hash: sha256(value) };
}

/** Hash of the API key in an `Authorization: Bearer` header, or null when the header is missing or malformed. */
export function bearerKeyHash(header: string | undefined): string | null {
  const key = header ? BEARER_RE.exec(header)?.[1] : undefined;
  return key && API_KEY_RE.test(key) ? sha256(key) : null;
}

/** Constant-time comparison of a presented admin token with the configured one. */
export function isAdminToken(presented: string | string[] | undefined, configured: string | undefined): boolean {
  if (!configured || typeof presented !== 'string' || !presented) return false;
  // Hashing first gives equal-length buffers, as timingSafeEqual requires, without leaking the length.
  return timingSafeEqual(Buffer.from(sha256(presented), 'hex'), Buffer.from(sha256(configured), 'hex'));
}
