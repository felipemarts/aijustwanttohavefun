import type { IncomingHttpHeaders } from 'node:http';
import { isIP, isIPv4 } from 'node:net';
import type { Config } from './config';

export type ClientIpSettings = Pick<Config, 'clientIpHeader' | 'trustProxy'>;

/** What a request's client address is derived from. */
export type ClientIpSource = {
  /** The TCP peer: the client itself, or the nearest proxy. */
  remoteAddress: string | undefined;
  headers: IncomingHttpHeaders;
  /**
   * The address Fastify already derived from X-Forwarded-For with the same `trustProxy` setting (`request.ip`),
   * so HTTP requests keep exactly Fastify's semantics. Absent for WebSocket upgrades, which Fastify never sees.
   */
  fastifyIp?: string;
};

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

/** Exact address or IPv4 CIDR (`10.0.0.0/8`). IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`) count as IPv4. */
export function ipMatches(ip: string, rule: string): boolean {
  const addr = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  const [net, bits] = rule.split('/');
  if (bits === undefined || !net) return addr === rule;
  if (!isIPv4(addr) || !isIPv4(net)) return false;
  const n = Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > 32) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (ipv4ToInt(addr) & mask) === (ipv4ToInt(net) & mask);
}

/**
 * The value of the configured client-IP header when it is exactly one IP address. A missing or empty header, a
 * repeated one (Node joins repeats with ", "), a list, or anything that is not an address gives undefined.
 */
function headerIp(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v && !v.includes(',') && isIP(v) !== 0 ? v : undefined;
}

/** X-Forwarded-For under `trustProxy`: never trusted unless configured; with a list, walked from the nearest hop. */
function forwardedIp(peer: string, forwarded: string | string[] | undefined, trust: Config['trustProxy']): string {
  if (trust === false || !forwarded) return peer;
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const chain = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (trust === true) return chain[0] ?? peer;
  const hops = [...chain, peer];
  for (let i = hops.length - 1; i > 0; i--) {
    if (!trust.some((rule) => ipMatches(hops[i]!, rule))) return hops[i]!;
  }
  return hops[0]!;
}

/**
 * The client address of a request: the ONE place it is derived, for every per-IP limit, the spectator connection
 * cap, the reporter hash, MCP's in-process calls and the request log.
 *
 * - `CLIENT_IP_HEADER` set (e.g. `Fly-Client-IP`): that single header, set by the platform's edge proxy, when it
 *   holds exactly one valid IP address; otherwise the socket address. X-Forwarded-For is ignored entirely, even
 *   with TRUST_PROXY set (the header wins; `loadConfig` also turns `trustProxy` off).
 * - Unset: Fastify's `trustProxy` semantics over X-Forwarded-For (off by default: the socket address).
 */
export function clientIp(src: ClientIpSource, settings: ClientIpSettings): string {
  const peer = src.remoteAddress ?? 'unknown';
  if (settings.clientIpHeader) return headerIp(src.headers[settings.clientIpHeader]) ?? peer;
  return src.fastifyIp ?? forwardedIp(peer, src.headers['x-forwarded-for'], settings.trustProxy);
}
