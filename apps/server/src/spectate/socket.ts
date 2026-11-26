import type { IncomingMessage, Server } from 'node:http';
import { isIPv4 } from 'node:net';
import type { Duplex } from 'node:stream';
import { SPECTATE_PATH } from '@ajwf/shared';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config';
import type { Metrics } from '../metrics';
import type { Broadcaster, SpectatorSocket } from './broadcaster';
import { SPECTATE } from './constants';

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
 * The client address of an upgrade request, following the same `trustProxy` setting as Fastify: never trust
 * X-Forwarded-For unless configured; with a list, walk the chain from the nearest hop while hops are trusted.
 */
export function clientIp(remote: string | undefined, forwarded: string | string[] | undefined, trust: Config['trustProxy']): string {
  const peer = remote ?? 'unknown';
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

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Adapts a `ws` socket to what the broadcaster needs. */
function adapt(ws: WebSocket, raw: Duplex & { bytesWritten?: number }): SpectatorSocket {
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    // Text frame from a shared buffer: ws neither copies nor re-encodes it per connection.
    send: (data) => ws.send(data, { binary: false }),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    ping: () => ws.ping(),
    wireBytes: () => raw.bytesWritten ?? 0,
  };
}

/**
 * Serves `GET /ws/spectate` (WebSocket upgrade) on the HTTP server Fastify listens with. Connection limits are
 * checked before the handshake; permessage-deflate compresses only frames worth compressing.
 */
export function attachSpectatorSocket(server: Server, deps: { broadcaster: Broadcaster; config: Config; metrics: Metrics; log: Logger }): WebSocketServer {
  const { broadcaster, config, metrics, log } = deps;
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: SPECTATE.maxMessageBytes,
    perMessageDeflate: {
      threshold: SPECTATE.deflateThresholdBytes,
      // No sliding window kept between messages: a little less compression, far less memory per connection.
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
      concurrencyLimit: 8,
    },
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== SPECTATE_PATH) return refuse(socket, 404, 'Not Found');
    const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustProxy);
    const admission = broadcaster.admit(ip);
    if (!admission.ok) {
      metrics.wsRejected++;
      return refuse(socket, admission.reason === 'ip_limit' ? 429 : 503, admission.reason === 'ip_limit' ? 'Too Many Requests' : 'Service Unavailable');
    }
    socket.on('error', () => socket.destroy());
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = broadcaster.attach(adapt(ws, req.socket), ip);
      ws.on('message', (data, isBinary) => broadcaster.handleMessage(conn, data, isBinary));
      ws.on('pong', () => (conn.alive = true));
      ws.on('close', () => broadcaster.detach(conn));
      ws.on('error', (err) => {
        log.debug({ err }, 'spectator socket error');
        broadcaster.detach(conn);
      });
    });
  });
  return wss;
}
