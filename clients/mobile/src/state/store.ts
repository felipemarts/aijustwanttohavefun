/**
 * The store: holds `AppState` outside React, feeds the reducer with the core's answers and events, and offers the
 * operations the screens need. Screens read it through `useApp` (hooks.ts).
 */
import type { CoreKind } from '../core/choose';
import {
  CODES,
  CoreFailure,
  isConnectionAware,
  type CharacterId,
  type ChatMessage,
  type ConnectionStatus,
  type Core,
  type EngineState,
  type Settings,
} from '../core/types';
import { initialState, LOG_PAGE, RECENT, reduce, type Action, type AppState } from './reducer';

export function failureOf(e: unknown): { code: string; message: string } {
  if (e instanceof CoreFailure) return { code: e.code, message: e.message };
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e) };
}

export class Store {
  state: AppState = initialState;
  readonly kind: CoreKind;
  readonly core: Core | null;
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  #stops: (() => void)[] = [];
  #lastConnection: ConnectionStatus | 'none' = 'none';
  #localSeq = 0;
  /**
   * Events seen per subject ('engine', 'char:<id>'). A request's answer is only applied when no event about the same
   * subject arrived while it was in flight: otherwise the event is newer (for example PUT /core/engine answers
   * "starting" after the stream already said "ready").
   */
  readonly #eventSeq = new Map<string, number>();

  constructor(boot: { kind: CoreKind; core: Core | null }, now: () => number = Date.now) {
    this.kind = boot.kind;
    this.core = boot.core;
    this.#now = now;
  }

  getState = (): AppState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  };

  dispatch(a: Action): void {
    const next = reduce(this.state, a);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.#listeners) l();
  }

  /** Connects to the core. Safe to call once. */
  async start(): Promise<void> {
    const core = this.core;
    if (!core) {
      this.dispatch({ t: 'failed', code: 'no_session', message: '' });
      return;
    }
    // Subscribe first so nothing that happens during the first load is missed.
    this.#stops.push(
      core.subscribe((ev) => {
        const subject = ev.type === 'engine' ? 'engine' : ev.type === 'character' ? `char:${ev.character.id}` : null;
        if (subject) this.#eventSeq.set(subject, (this.#eventSeq.get(subject) ?? 0) + 1);
        this.dispatch({ t: 'event', ev, now: this.#now() });
      }),
    );
    if (isConnectionAware(core)) {
      this.#stops.push(
        core.onConnection((status) => {
          const was = this.#lastConnection;
          this.#lastConnection = status;
          this.dispatch({ t: 'connection', status });
          // Events were missed while the stream was down: catch up.
          if (status === 'live' && was === 'reconnecting') void this.resync();
        }),
      );
    }
    await this.load();
  }

  stop(): void {
    for (const s of this.#stops) s();
    this.#stops = [];
  }

  async load(): Promise<void> {
    if (!this.core) return;
    try {
      const state = await this.core.state();
      this.dispatch({ t: 'loaded', state });
      // A few recent entries per character, so Home can say what each one did last and whether it looks stuck.
      await Promise.all(state.characters.map((c) => this.loadRecent(c.id)));
    } catch (e) {
      this.dispatch({ t: 'failed', ...failureOf(e) });
    }
  }

  async loadRecent(id: CharacterId): Promise<void> {
    if (!this.core) return;
    try {
      this.dispatch({ t: 'recent', id, entries: await this.core.log(id, { limit: RECENT }) });
    } catch {
      // the Home news line is a nicety
    }
  }

  async resync(): Promise<void> {
    await this.load();
    for (const id of Object.keys(this.state.logs)) void this.refreshLog(id);
  }

  // ── log ────────────────────────────────────────────────────────────────────────────────────────────────────
  async openLog(id: CharacterId): Promise<void> {
    const cur = this.state.logs[id];
    if (cur?.loaded || cur?.loading) return;
    await this.refreshLog(id);
  }

  async refreshLog(id: CharacterId): Promise<void> {
    if (!this.core) return;
    this.dispatch({ t: 'logLoading', id });
    try {
      const entries = await this.core.log(id, { limit: LOG_PAGE });
      this.dispatch({ t: 'logPage', id, entries, older: false, limit: LOG_PAGE });
    } catch {
      this.dispatch({ t: 'logFailed', id });
    }
  }

  async loadOlder(id: CharacterId): Promise<void> {
    const cur = this.state.logs[id];
    if (!this.core || !cur || cur.loading || cur.exhausted) return;
    const oldest = cur.entries[cur.entries.length - 1];
    this.dispatch({ t: 'logLoading', id });
    try {
      const entries = await this.core.log(id, { before: oldest?.id, limit: LOG_PAGE });
      this.dispatch({ t: 'logPage', id, entries, older: true, limit: LOG_PAGE });
    } catch {
      this.dispatch({ t: 'logFailed', id });
    }
  }

  // ── character ──────────────────────────────────────────────────────────────────────────────────────────────
  async openCharacter(id: CharacterId): Promise<void> {
    if (!this.core) return;
    const detail = await this.core.character(id);
    this.dispatch({ t: 'detail', detail });
  }

  /** The owner has seen the "while you were away" summary. */
  async seen(id: CharacterId): Promise<void> {
    if (!this.core) return;
    const core = this.core;
    const character = await this.#unlessNewer(`char:${id}`, () => core.seen(id));
    this.dispatch({ t: 'seen', id });
    if (character) this.dispatch({ t: 'character', character, now: this.#now() });
  }

  async control(id: CharacterId, run: boolean): Promise<void> {
    if (!this.core) return;
    const core = this.core;
    const character = await this.#unlessNewer(`char:${id}`, () => core.control(id, run));
    if (character) this.dispatch({ t: 'character', character, now: this.#now() });
  }

  /** Runs a request and returns its answer, or null when an event about the same subject arrived meanwhile. */
  async #unlessNewer<T>(subject: string, request: () => Promise<T>): Promise<T | null> {
    const before = this.#eventSeq.get(subject) ?? 0;
    const out = await request();
    return (this.#eventSeq.get(subject) ?? 0) === before ? out : null;
  }

  /** An engine request (choose, download, pause, cancel): its answer is applied unless the stream already moved on. */
  async engineAction(request: (core: Core) => Promise<EngineState>): Promise<void> {
    if (!this.core) return;
    const core = this.core;
    const engine = await this.#unlessNewer('engine', () => request(core));
    if (engine) this.dispatch({ t: 'engine', engine });
  }

  // ── chat ───────────────────────────────────────────────────────────────────────────────────────────────────
  async loadChat(id: CharacterId): Promise<void> {
    if (!this.core) return;
    try {
      this.dispatch({ t: 'chatHistory', id, messages: await this.core.chatHistory(id, 100) });
    } catch {
      // history is a nicety; the conversation still works
    }
  }

  /** Shows the owner's line at once, then waits for the reply (whose tokens stream in through `chat` events). */
  async sendChat(id: CharacterId, text: string): Promise<ChatMessage> {
    if (!this.core) throw new CoreFailure(CODES.notOnDevice, '');
    const mine: ChatMessage = { id: `local-${++this.#localSeq}`, ts: this.#now(), from: 'owner', text };
    this.dispatch({ t: 'chatMessage', id, message: mine });
    const reply = await this.core.chat(id, text);
    this.dispatch({ t: 'chatMessage', id, message: reply });
    return reply;
  }

  // ── settings and engine ────────────────────────────────────────────────────────────────────────────────────
  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    if (!this.core) throw new CoreFailure(CODES.notOnDevice, '');
    const settings = await this.core.setSettings(patch);
    this.dispatch({ t: 'settings', settings });
    return settings;
  }
}
