/**
 * Spectator load generator: opens many WebSocket spectator connections to one server, subscribes each to a topic
 * and counts what arrives. Prints one JSON line per report to stdout.
 *
 * Standalone on purpose: it imports only `ws` and Node built-ins and uses only erasable TypeScript, so it runs
 * with tsx on the host and with `node --experimental-strip-types` inside a container (the bench spreads the load
 * over several of these processes: one process cannot hold 20,000 sockets on most laptops).
 *
 *   loader.ts <ws url> <connections> <opens per second> <seconds> <id> <room ids, comma-separated> [deflate share]
 *
 * Only a share of the connections (default 10%) negotiate permessage-deflate: inflating every message for
 * thousands of sockets would make this process, not the server, the bottleneck on one machine. The server's cost
 * per connection is the same either way (it compresses each message once for all), and the wire bytes of the
 * compressed connections are counted apart, so the bandwidth a browser would use is still measured.
 */
import { WebSocket } from 'ws';

const [url, connsArg, openRateArg, secondsArg, id, roomsArg] = process.argv.slice(2);
if (!url || !connsArg) {
  console.error('usage: loader.ts <ws url> <connections> <opens/s> <seconds> <id> <rooms>');
  process.exit(2);
}
const conns = Number(connsArg);
const openRate = Number(openRateArg ?? 500);
const seconds = Number(secondsArg ?? 60);
const rooms = (roomsArg ?? '').split(',').filter(Boolean);
const deflateShare = Number(process.argv[8] ?? 0.1);

type Stats = {
  open: number;
  opened: number;
  failed: number;
  closed: number;
  msgs: number;
  bytes: number;
  batches: number;
  fulls: number;
  errors: number;
  connectMs: number[];
  closeCodes: Record<string, number>;
  deflateOpen: number;
};
const st: Stats = { open: 0, opened: 0, failed: 0, closed: 0, msgs: 0, bytes: 0, batches: 0, fulls: 0, errors: 0, connectMs: [], closeCodes: {}, deflateOpen: 0 };
/** TCP sockets of the connections that negotiated compression: their bytesRead is what a browser downloads. */
const deflateSockets: { bytesRead: number }[] = [];
const sockets: WebSocket[] = [];
let stopping = false;

/** Mostly `world` (the map everyone opens), some rooms (following a fight), a few `village` (the dashboard). */
function topicFor(i: number): string {
  const r = (i * 2654435761) % 100;
  if (r < 80 || !rooms.length) return 'world';
  if (r < 95) return `room:${rooms[i % rooms.length]}`;
  return 'village';
}

function open(i: number): void {
  const t0 = Date.now();
  const deflate = (i * 0.618034) % 1 < deflateShare;
  const ws = new WebSocket(url!, { perMessageDeflate: deflate, handshakeTimeout: 30_000 });
  sockets.push(ws);
  let wasOpen = false;
  ws.on('upgrade', (res) => {
    if (deflate) deflateSockets.push(res.socket);
  });
  ws.on('open', () => {
    wasOpen = true;
    if (deflate) st.deflateOpen++;
    st.open++;
    st.opened++;
    if (st.connectMs.length < 5000) st.connectMs.push(Date.now() - t0);
    ws.send(JSON.stringify({ op: 'sub', topics: [topicFor(i)] }));
  });
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    st.msgs++;
    st.bytes += data.length;
    if (isBinary) return;
    // Cheap classification without parsing every message: the type is the first field.
    const head = data.subarray(0, 12).toString('latin1');
    if (head.startsWith('{"t":"batch"')) st.batches++;
    else if (head.startsWith('{"t":"full"')) st.fulls++;
    else if (head.startsWith('{"t":"error"')) st.errors++;
  });
  ws.on('error', () => {
    // 'close' follows
  });
  ws.on('close', (code: number) => {
    if (stopping) return;
    st.closeCodes[String(code)] = (st.closeCodes[String(code)] ?? 0) + 1;
    if (wasOpen) {
      st.open--;
      st.closed++;
    } else st.failed++;
  });
}

function report(final = false): void {
  const c = [...st.connectMs].sort((a, b) => a - b);
  const p = (q: number) => c[Math.min(c.length - 1, Math.floor(q * c.length))] ?? 0;
  const deflateWireBytes = deflateSockets.reduce((a, x) => a + x.bytesRead, 0);
  const line = { id, final, t: Date.now(), deflateOpen: st.deflateOpen, deflateWireBytes, open: st.open, opened: st.opened, failed: st.failed, closed: st.closed, msgs: st.msgs, bytes: st.bytes, batches: st.batches, fulls: st.fulls, errors: st.errors, connectP50: p(0.5), connectP99: p(0.99), closeCodes: st.closeCodes, rssMb: Math.round(process.memoryUsage().rss / 2 ** 20) };
  process.stdout.write(JSON.stringify(line) + '\n');
}

let next = 0;
const opener = setInterval(() => {
  const n = Math.max(1, Math.round(openRate / 20));
  for (let k = 0; k < n && next < conns; k++) open(next++);
  if (next >= conns) clearInterval(opener);
}, 50);
const reporter = setInterval(() => report(), 5000);

function finish(): void {
  if (stopping) return;
  stopping = true;
  clearInterval(opener);
  clearInterval(reporter);
  report(true);
  for (const ws of sockets) ws.terminate();
  setTimeout(() => process.exit(0), 200);
}
setTimeout(finish, seconds * 1000);
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
