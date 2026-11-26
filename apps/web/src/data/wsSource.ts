import {
  backoffMs,
  type DataSource,
  getJson,
  loadImage,
  npcSpriteUrl,
  type SourceHandlers,
  spriteUrl,
} from './source';

const PING_MS = 25_000;
const SILENCE_MS = 70_000;

/** The real spectator WebSocket (`/ws/spectate`), with reconnect, backoff and resubscribe. */
export class WsSource implements DataSource {
  readonly kind = 'ws' as const;
  private ws: WebSocket | null = null;
  private handlers: SourceHandlers | null = null;
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private attempt = 0;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private maxTopics = 16;

  constructor(private readonly url = WsSource.defaultUrl()) {}

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws/spectate`;
  }

  connect(handlers: SourceHandlers) {
    this.handlers = handlers;
    this.closed = false;
    this.open();
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private onVisible = () => {
    // Coming back to a tab with a dead socket: retry now instead of waiting for the backoff.
    if (document.visibilityState === 'visible' && !this.ws && !this.closed) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.open();
    }
  };

  private open() {
    this.retryTimer = null;
    this.handlers?.status(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.subscribed.clear();
    ws.onopen = () => {
      this.lastMessageAt = Date.now();
      this.flushTopics();
      this.startPing();
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now();
      if (typeof e.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') {
        const m = msg as { t?: unknown; maxTopics?: unknown };
        if (m.t === 'hello') {
          this.attempt = 0;
          if (typeof m.maxTopics === 'number' && m.maxTopics > 0) this.maxTopics = m.maxTopics;
          this.handlers?.status('live');
        }
      }
      this.handlers?.message(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (!this.closed) this.scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // already closing
      }
    };
  }

  private scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    this.handlers?.status(this.attempt >= 8 ? 'offline' : 'reconnecting');
    const delay = backoffMs(this.attempt++);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > SILENCE_MS) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ op: 'ping' }));
    }, PING_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  setTopics(topics: readonly string[]) {
    this.wanted = new Set(topics.slice(0, this.maxTopics));
    this.flushTopics();
  }

  private flushTopics() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const unsub = [...this.subscribed].filter((t) => !this.wanted.has(t));
    const sub = [...this.wanted].filter((t) => !this.subscribed.has(t));
    if (unsub.length) {
      ws.send(JSON.stringify({ op: 'unsub', topics: unsub }));
      for (const t of unsub) this.subscribed.delete(t);
    }
    if (sub.length) {
      ws.send(JSON.stringify({ op: 'sub', topics: sub }));
      for (const t of sub) this.subscribed.add(t);
    }
  }

  close() {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  getJson(path: string) {
    return getJson(path);
  }

  spriteImage(hash: string) {
    const url = spriteUrl(hash);
    return url ? loadImage(url) : Promise.resolve(null);
  }

  npcSpriteImage(id: string) {
    const url = npcSpriteUrl(id);
    return url ? loadImage(url) : Promise.resolve(null);
  }
}
