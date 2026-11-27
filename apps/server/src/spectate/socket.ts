import type { IncomingMessage, Server } from 'node:http';
import { isIPv4 } from 'node:net';
import type { Duplex } from 'node:stream';
import { constants as zlibConstants, deflateRawSync } from 'node:zlib';
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

/**
 * Server-to-client WebSocket frames for one message, built once and shared by every connection that receives it.
 *
 * `ws` compresses every `send` separately for each connection (its own zlib stream, on the libuv pool): with one
 * batch going to thousands of spectators that is the same compression done thousands of times, the largest CPU
 * and memory cost of the broadcast. With `server_no_context_takeover` (which this server always negotiates) each
 * message is compressed on its own, so one compressed frame is valid for every connection that negotiated
 * permessage-deflate with the default 15-bit window: it is deflated once (RFC 7692 §7.2.1: raw deflate, sync
 * flush, trailing 00 00 ff ff removed) and written as is.
 */
type Frames = { plain?: Buffer; deflated?: Buffer };
const frameCache = new WeakMap<Buffer, Frames>();

/** FIN + text opcode, RSV1 when compressed; unmasked (server to client), RFC 6455 §5.2. */
export function textFrame(payload: Buffer, compressed: boolean): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65_536 ? 4 : 10;
  const out = Buffer.allocUnsafe(head + len);
  out[0] = 0x81 | (compressed ? 0x40 : 0);
  if (len < 126) out[1] = len;
  else if (len < 65_536) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 127;
    out.writeUInt32BE(0, 2);
    out.writeUInt32BE(len, 6);
  }
  payload.copy(out, head);
  return out;
}

/** The message as permessage-deflate data (`server_no_context_takeover`, 15-bit window). */
export function deflateMessage(data: Buffer): Buffer {
  const out = deflateRawSync(data, { level: 6, memLevel: 7, windowBits: 15, finishFlush: zlibConstants.Z_SYNC_FLUSH });
  return out.subarray(0, out.length - 4);
}

function sharedFrame(data: Buffer, deflate: boolean): Buffer {
  let f = frameCache.get(data);
  if (!f) frameCache.set(data, (f = {}));
  if (deflate) return (f.deflated ??= textFrame(deflateMessage(data), true));
  return (f.plain ??= textFrame(data, false));
}

/**
 * How frames reach this connection: shared frames written to the raw socket (`deflate` or `plain`), or `ws.send`
 * for a client that asked for a smaller compression window than the shared frames use (rare; browsers do not).
 */
export function framing(extensions: string): 'deflate' | 'plain' | 'ws' {
  if (!/permessage-deflate/.test(extensions)) return 'plain';
  const bits = /server_max_window_bits=(\d+)/.exec(extensions);
  return bits && Number(bits[1]) < 15 ? 'ws' : 'deflate';
}

/**
 * Adapts a `ws` socket to what the broadcaster needs. Shared frames are written straight to the TCP socket; this
 * is safe because `ws` itself never compresses here (every data frame goes through this function), so its sender
 * never queues and its own control frames (pong, close) are written in order with ours.
 */
function adapt(ws: WebSocket, raw: Duplex & { bytesWritten?: number }): SpectatorSocket {
  const mode = framing(ws.extensions);
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => {
      if (ws.readyState !== ws.OPEN) return;
      if (mode === 'ws') ws.send(data, { binary: false });
      else raw.write(sharedFrame(data, mode === 'deflate' && data.length >= SPECTATE.deflateThresholdBytes));
    },
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    ping: () => ws.ping(),
    wireBytes: () => raw.bytesWritten ?? 0,
  };
}

/**
 * Serves `GET /ws/spectate` (WebSocket upgrade) on the HTTP server Fastify listens with. Connection limits are
 * checked before the handshake; permessage-deflate compresses only frames worth compressing, once per message
 * for all connections (see `adapt`).
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
