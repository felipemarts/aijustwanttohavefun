import { randomBytes } from 'node:crypto';
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
  TRUST_PROXY: optional(z.string().min(1)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORLD_SEED: optional(z.coerce.number().int()),
  WS_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(20_000),
  WS_MAX_PER_IP: z.coerce.number().int().min(1).default(20),
});

export type Config = {
  production: boolean;
  port: number;
  databaseUrl: string | undefined;
  publicUrl: string;
  sessionSecret: string;
  adminToken: string | undefined;
  devLogin: boolean;
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
  return {
    production,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    publicUrl: e.PUBLIC_URL,
    // Owner sessions arrive in a later milestone; until then an ephemeral secret is enough outside production.
    sessionSecret: e.SESSION_SECRET ?? randomBytes(32).toString('base64url'),
    adminToken: e.ADMIN_TOKEN,
    devLogin: e.DEV_LOGIN === '1' && !production,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    logLevel: e.LOG_LEVEL,
    worldSeed: e.WORLD_SEED ?? randomBytes(4).readUInt32LE(0),
    wsMaxConnections: e.WS_MAX_CONNECTIONS,
    wsMaxPerIp: e.WS_MAX_PER_IP,
  };
}
