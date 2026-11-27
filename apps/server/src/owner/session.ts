import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256 } from '../auth';
import type { Store } from '../store/types';

const DAY_MS = 24 * 3_600_000;
/** Lifetime of a session from its last refresh. */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Absolute cap from login: however often it is refreshed, a session ends this long after it was created. */
export const SESSION_MAX_AGE_MS = 90 * DAY_MS;
/** The expiry slides forward at most this often (one write a day per active owner). */
export const SESSION_REFRESH_MS = DAY_MS;
/** 32 random bytes in base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** `__Host-` names (Secure, Path=/, no Domain) in production; plain names on http during development. */
export function cookieNames(production: boolean) {
  return production ? { session: '__Host-ajwf_session', oauth: '__Host-ajwf_oauth' } : { session: 'ajwf_session', oauth: 'ajwf_oauth' };
}

export function cookieOptions(production: boolean, maxAgeMs: number) {
  return { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/', maxAge: Math.floor(maxAgeMs / 1000) };
}

export type OwnerSession = { id: string; ownerId: string };

/**
 * Owner login sessions (§15.2): an opaque random cookie, of which only the SHA-256 is stored. Rotated at login,
 * deleted at logout, expired 30 days after the last refresh (refreshed at most once a day) and never later than 90
 * days after login.
 */
export class Sessions {
  readonly names: { session: string; oauth: string };

  constructor(
    private store: Store,
    private now: () => number,
    private production: boolean,
  ) {
    this.names = cookieNames(production);
  }

  private token(req: FastifyRequest): string | null {
    const v = req.cookies[this.names.session];
    return v && TOKEN_RE.test(v) ? v : null;
  }

  /** Starts a session for the owner, replacing (and deleting) the one this browser had. */
  async create(req: FastifyRequest, reply: FastifyReply, ownerId: string): Promise<void> {
    const previous = this.token(req);
    if (previous) await this.store.deleteSession(sha256(previous));
    const value = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.store.createSession({ id: sha256(value), ownerId, expiresAt: now + SESSION_TTL_MS, refreshedAt: now, createdAt: now });
    reply.setCookie(this.names.session, value, cookieOptions(this.production, SESSION_TTL_MS));
  }

  /** The session of this request, or null (no cookie, unknown, expired). Slides the expiry when a day has passed. */
  async read(req: FastifyRequest, reply: FastifyReply): Promise<OwnerSession | null> {
    const value = this.token(req);
    if (!value) return null;
    const id = sha256(value);
    const row = await this.store.getSession(id);
    const now = this.now();
    if (!row) return null;
    // The cap is checked on every read, not only at refresh: rows refreshed before it existed may expire later.
    const cap = row.createdAt + SESSION_MAX_AGE_MS;
    if (row.expiresAt <= now || cap <= now) {
      await this.store.deleteSession(id);
      return null;
    }
    if (now - row.refreshedAt >= SESSION_REFRESH_MS) {
      const expiresAt = Math.min(now + SESSION_TTL_MS, cap);
      if (expiresAt > row.expiresAt) {
        await this.store.refreshSession(id, expiresAt, now);
        reply.setCookie(this.names.session, value, cookieOptions(this.production, expiresAt - now));
      }
    }
    return { id, ownerId: row.ownerId };
  }

  /** Logout: the row is deleted and the cookie cleared. */
  async destroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const value = this.token(req);
    if (value) await this.store.deleteSession(sha256(value));
    this.clear(reply);
  }

  clear(reply: FastifyReply): void {
    reply.clearCookie(this.names.session, cookieOptions(this.production, 0));
  }
}
