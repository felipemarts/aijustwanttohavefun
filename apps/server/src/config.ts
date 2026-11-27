import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Empty strings (`ADMIN_TOKEN=` in a copied .env) mean "not set". */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: optional(z.enum(['development', 'production', 'test'])),
  PORT: z.coerce.number().int().min(1).max(65535).default(8710),
  DATABASE_URL: optional(z.string().min(1)),
  PUBLIC_URL: z
    .url()
    .default('http://localhost:8710')
    .transform((u) => u.replace(/\/+$/, '')),
  SESSION_SECRET: optional(z.string().min(32)),
  ADMIN_TOKEN: optional(z.string().min(1)),
  DEV_LOGIN: optional(z.enum(['0', '1'])),
  /** Development only: the Vite dev server's origin, accepted by the owner routes' same-origin check. */
  DEV_WEB_ORIGIN: optional(z.url()),
  OAUTH_GITHUB_ID: optional(z.string().min(1)),
  OAUTH_GITHUB_SECRET: optional(z.string().min(1)),
  OAUTH_GOOGLE_ID: optional(z.string().min(1)),
  OAUTH_GOOGLE_SECRET: optional(z.string().min(1)),
  VAPID_PUBLIC_KEY: optional(z.string().min(1)),
  VAPID_PRIVATE_KEY: optional(z.string().min(1)),
  /** `mailto:` or `https:` contact for push services; defaults to PUBLIC_URL when it is https. */
  VAPID_SUBJECT: optional(z.string().min(1)),
  /** Built web app to serve (index.html and assets). Defaults to apps/web/dist in production. */
  WEB_DIST: optional(z.string().min(1)),
  /** Disk cache of composed sprites and share cards (rebuilt on demand, safe to lose). */
  CACHE_DIR: optional(z.string().min(1)),
  TRUST_PROXY: optional(z.string().min(1)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORLD_SEED: optional(z.coerce.number().int()),
  WS_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(20_000),
  WS_MAX_PER_IP: z.coerce.number().int().min(1).default(20),
});

export type OAuthClient = { id: string; secret: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string };

/** Default location of the built web app. */
export const DEFAULT_WEB_DIST = join(import.meta.dirname, '..', '..', 'web', 'dist');
/** Default disk cache (gitignored). */
export const DEFAULT_CACHE_DIR = join(import.meta.dirname, '..', '.cache');

export type Config = {
  production: boolean;
  port: number;
  databaseUrl: string | undefined;
  publicUrl: string;
  sessionSecret: string;
  adminToken: string | undefined;
  devLogin: boolean;
  /** OAuth apps by provider; a provider without both id and secret is not offered. */
  oauth: { github?: OAuthClient; google?: OAuthClient };
  /** Web Push keys; null turns push notifications off. */
  vapid: Vapid | null;
  /** Origins besides PUBLIC_URL's accepted by the owner routes (development only). */
  extraOrigins: string[];
  /** Directory of the built web app, or null to answer page routes with a minimal HTML shell only. */
  webDist: string | null;
  /** Where sprites and share cards are cached on disk. */
  cacheDir: string;
  /**
   * Passed to Fastify's `trustProxy`: off by default so X-Forwarded-For cannot spoof the client IP. `true` trusts
   * any proxy; a comma-separated list trusts only those addresses or CIDR ranges.
   */
  trustProxy: boolean | string[];
  logLevel: string;
  worldSeed: number;
  /** Spectator WebSocket limits: connections in total and per client IP. */
  wsMaxConnections: number;
  wsMaxPerIp: number;
};

function parseTrustProxy(raw: string | undefined): Config['trustProxy'] {
  if (!raw || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  const production = e.NODE_ENV === 'production';
  if (production && !e.SESSION_SECRET) throw new Error('SESSION_SECRET (at least 32 characters) is required in production');
  // Owner cookies are `Secure` and `__Host-` prefixed in production: they only work over https.
  if (production && !e.PUBLIC_URL.startsWith('https://')) throw new Error('PUBLIC_URL must be an https URL in production');
  const client = (id?: string, secret?: string): OAuthClient | undefined => (id && secret ? { id, secret } : undefined);
  const github = client(e.OAUTH_GITHUB_ID, e.OAUTH_GITHUB_SECRET);
  const google = client(e.OAUTH_GOOGLE_ID, e.OAUTH_GOOGLE_SECRET);
  const subject = e.VAPID_SUBJECT ?? (e.PUBLIC_URL.startsWith('https://') ? e.PUBLIC_URL : 'mailto:owner@localhost');
  const webDist = e.WEB_DIST ?? (production ? DEFAULT_WEB_DIST : undefined);
  return {
    production,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    publicUrl: e.PUBLIC_URL,
    // Signs the OAuth attempt cookie and keys the reporter-IP hash. Outside production a random one per process is
    // enough (a restart only invalidates logins in progress).
    sessionSecret: e.SESSION_SECRET ?? randomBytes(32).toString('base64url'),
    adminToken: e.ADMIN_TOKEN,
    devLogin: e.DEV_LOGIN === '1' && !production,
    oauth: { ...(github ? { github } : {}), ...(google ? { google } : {}) },
    vapid: e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject } : null,
    extraOrigins: !production && e.DEV_WEB_ORIGIN ? [new URL(e.DEV_WEB_ORIGIN).origin] : [],
    webDist: webDist && existsSync(join(webDist, 'index.html')) ? webDist : null,
    cacheDir: e.CACHE_DIR ?? DEFAULT_CACHE_DIR,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    logLevel: e.LOG_LEVEL,
    worldSeed: e.WORLD_SEED ?? randomBytes(4).readUInt32LE(0),
    wsMaxConnections: e.WS_MAX_CONNECTIONS,
    wsMaxPerIp: e.WS_MAX_PER_IP,
  };
}
