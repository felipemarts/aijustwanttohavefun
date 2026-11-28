/**
 * The Core API: the one contract between the player client's interface and its "core", the part that owns the
 * characters, talks to the game server, runs the local AI and plays.
 *
 * There are two cores and one interface:
 *   - desktop (Windows, macOS, Linux): the core is the Go program; the interface is the web build of the Expo app,
 *     served by that program on 127.0.0.1 and talking to it over the HTTP routes below (`RemoteCore`);
 *   - mobile (Android, iOS): the core runs inside the app, in TypeScript (`LocalCore`), with the same methods.
 * The interface only ever sees this file's types. It never sees an agent API key, and neither does the model.
 *
 * HTTP mapping (desktop), all under `/core`, JSON bodies. Authentication: the program opens the interface at
 * `http://127.0.0.1:<port>/#token=<launch token>`; the page sends `POST /core/session` with `{ token }` and gets an
 * HttpOnly, SameSite=Strict session cookie for this run. Every other `/core` route accepts that cookie or
 * `Authorization: Bearer <launch token>`. With the cookie, POST, PUT and DELETE must carry `Origin` equal to the
 * page's own origin and `Content-Type: application/json` (also when the body is empty: send `{}`). The `Host` header
 * must be `127.0.0.1:<port>` or `localhost:<port>` on every request. A closed tab is reopened with `ajwf-player open`.
 *   POST   /core/session                       <- { token: string }      -> { ok: true } and the cookie
 *   GET    /core/state                         -> CoreState
 *   GET    /core/events                        -> Server-Sent Events, each `data:` one CoreEvent, a `: keepalive`
 *                                                 comment every 15 s; refetch the state when the stream reconnects
 *   GET    /core/appearance/options            -> AppearanceOptions (from the game server, cached by its token)
 *   POST   /core/characters                    <- NewCharacter           -> CharacterSummary (created running; `blocked`
 *                                                 with the reason while no engine is ready)
 *   GET    /core/characters/:id                -> CharacterDetail
 *   POST   /core/characters/:id/seen           -> CharacterSummary (clears `away`)
 *   GET    /core/characters/:id/claim          -> { url: string | null } (the claim link, only here)
 *   GET    /core/characters/:id/log?before=<LogEntry.id>&limit=<n>  -> LogEntry[] (newest first)
 *   POST   /core/characters/:id/control        <- { run: boolean }       -> CharacterSummary
 *   PUT    /core/characters/:id/directives     <- Directives             -> Directives
 *   POST   /core/characters/:id/command        <- { text: string }       -> { ok: true } (a wish for the next turns;
 *                                                 it wakes a resting character)
 *   POST   /core/characters/:id/chat           <- { text: string }       -> ChatMessage (the reply; tokens also arrive as `chat` events)
 *   GET    /core/characters/:id/chat?limit=<n> -> ChatMessage[] (oldest first)
 *   DELETE /core/characters/:id                -> { ok: true }  (forgets it on this device; the agent stays in the world)
 *   GET    /core/settings                      -> Settings
 *   PUT    /core/settings                      <- Partial<Settings>      -> Settings
 *   GET    /core/engine                        -> EngineState
 *   GET    /core/engine/providers              -> ProviderInfo[] (probes the usual local addresses, read-only)
 *   GET    /core/engine/providers?url=<address> -> ProviderInfo (probes that one http(s) address, read-only)
 *   PUT    /core/engine                        <- EngineChoice           -> EngineState
 *   POST   /core/engine/download               -> EngineState (starts or resumes the built-in model download)
 *   POST   /core/engine/download/pause         -> EngineState (pauses it, keeping the partial file)
 *   DELETE /core/engine/download               -> EngineState (cancels it and deletes the partial file)
 *   POST   /core/engine/test                   -> EngineTest
 * Errors: HTTP 4xx/5xx with `CoreError`.
 *
 * The interface is a single-page app served by the core: files under `/_expo/` and `/assets/`, `index.html` for every
 * other path outside `/core`.
 */

/**
 * `code` is one of `CoreErrorCode` (the interface translates those) or another code, then show `message`.
 *   network: the game server did not answer; unauthorized: no or wrong session; not_available: the AI engine is not
 *   ready; NAME_TAKEN, INVALID_NAME, OPTIONS_EXPIRED: from creating a character; INVALID_URL: a server or engine URL.
 */
export type CoreErrorCode = 'network' | 'unauthorized' | 'not_available' | 'NAME_TAKEN' | 'INVALID_NAME' | 'INVALID_URL' | 'OPTIONS_EXPIRED';
export type CoreError = { error: { code: CoreErrorCode | (string & {}); message: string } };

// ── Characters ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Local id of a character on this device (not the agent's server id, never the API key). */
export type CharacterId = string;

export type CharacterStatus =
  | 'playing' // the core is taking actions for it
  | 'thinking' // waiting for the model right now
  | 'resting' // told to run, but waiting: out of AP, a cooldown, or between sessions (see `nextActionAt`)
  | 'paused' // the owner paused it
  | 'fallen' // dead in the game, waiting for a revive or the temple
  | 'blocked' // cannot play: no engine ready, server unreachable, key refused (see `problem`)
  ;

/** `[current, max]`. */
export type Gauge = [number, number];

export type CharacterSummary = {
  id: CharacterId;
  name: string;
  class: 'warrior' | 'mage' | 'rogue' | 'cleric';
  level: number;
  /** XP into the current level and XP the level needs. */
  xp: Gauge;
  hp: Gauge;
  mp: Gauge;
  ap: Gauge;
  gold: number;
  /** Where it is, with the name already in the interface language. */
  room: { id: string; name: string };
  /** Absolute URL of its sprite sheet on the game server (80x28 PNG, 4 frames of 20x28), or null before the first sync. */
  sprite: string | null;
  title: string | null;
  status: CharacterStatus;
  /** One line about what it is doing now, in the interface language ("Fighting a wolf", "Resting until 14:32"). */
  activity: string;
  /** When the core plans to act next (ms epoch), when it is resting. */
  nextActionAt?: number;
  /** Why it is blocked, in the interface language. */
  problem?: string;
  /** False until a human claimed it on the game's site: unclaimed agents cannot speak and stop at level 3. */
  claimed: boolean;
  /**
   * True while the claim link is unused. The link itself comes only from `claimLink(id)`
   * (`GET /core/characters/:id/claim`), never in summaries or events, and is never shown to the model.
   */
  claimPending: boolean;
  /** Its public page on the game's site, to watch it on the map. */
  watchUrl: string;
  /** What happened since the owner last looked at this character; cleared by `seen(id)`. */
  away?: AwaySummary;
  /**
   * Set by the core while the character is making no progress, so the owner can nudge it; absent otherwise.
   * `refusals`: the game keeps refusing what it tries. `no_progress`: turns pass with no XP, gold, item or quest
   * step. `lost`: it cannot find the place its quest needs. `since` is when it began (ms epoch). The interface
   * words the reason itself, so no text is carried here.
   */
  stuck?: { since: number; reason: 'refusals' | 'no_progress' | 'lost' };
};

/** "While you were away": totals since the owner last opened the character. */
export type AwaySummary = {
  since: number;
  actions: number;
  levels: number;
  xp: number;
  gold: number;
  kills: number;
  deaths: number;
  /** Up to five short lines worth telling, newest first, in the interface language. */
  highlights: string[];
};

/**
 * Room, item and quest names are shown as the game returns them (in the character's language; for inventory items
 * and quests the compact API gives ids, so `name` is the id). Only stat and slot names are localized by the core,
 * in the interface language.
 */
export type ItemStack = { id: string; name: string; qty: number; slot?: { id: string; name: string } };
export type QuestProgress = { id: string; name: string; steps: { text: string; have: number; need: number }[]; ready: boolean };

export type CharacterDetail = CharacterSummary & {
  /** The public bio the game shows (not the private persona). */
  bio: string;
  stats: { id: string; name: string; value: number }[];
  inventory: ItemStack[];
  quests: QuestProgress[];
  /** Achievement names, newest first. */
  achievements: string[];
  party: { members: string[] } | null;
  guild: string | null;
  directives: Directives;
  /** What the character currently remembers (its own notes), for the owner to read. */
  memory: string[];
};

/** How the owner steers a character. All of it stays on the device. */
export type Directives = {
  /** Who it is: a few sentences. Written at creation, editable. */
  persona: string;
  /** A standing wish ("get rich", "make friends and never betray them"). A wish, not a command the game enforces. */
  wish: string;
  /** How often it plays. `relaxed`: a short session about once an hour; `normal`: every 15 minutes; `active`: all the time. */
  pace: 'relaxed' | 'normal' | 'active';
  /**
   * May it attack or steal from other players' agents. When false the core never offers `steal`, `duel_invite` or
   * `duel_accept`; `attack` and `taunt` may target only monsters; `cast` on an agent only with a supportive skill.
   * Enforced by the per-turn schema and again before sending, never by asking the model.
   */
  allowPvp: boolean;
};

export type NewCharacter = {
  name: string;
  class: CharacterSummary['class'];
  /** BCP-47 tag the game narrates in and the character speaks. */
  language: string;
  /** Private: stays on the device and steers the model. Never sent to the game. */
  persona: string;
  /** Public bio the game shows, up to 300 characters. Optional. */
  bio?: string;
  /** Optional first directives (defaults: no wish, `normal`, no PvP). */
  wish?: string;
  pace?: Directives['pace'];
  allowPvp?: boolean;
  /** `surprise_me`, or one option id per layer together with the token of the options they came from. */
  appearance: 'surprise_me' | { optionsToken: string; choice: Record<string, string> };
};

/** The game server's appearance options: per layer, option id -> description in the interface language. */
export type AppearanceOptions = { optionsToken: string; expiresIn: number; options: Record<string, Record<string, string>> };

// ── The activity log ───────────────────────────────────────────────────────────────────────────────────────────

export type LogEntry = {
  /** Sortable, unique per character. */
  id: string;
  ts: number;
  kind:
    | 'action' // something the character did, with the game's narration
    | 'refused' // an action the game refused
    | 'event' // something that happened to or around it (from the game's event feed)
    | 'system' // the core itself: started, paused, engine problem
    ;
  /** The game's narration or the core's message, ready to show. */
  text: string;
  /** For `action` and `refused`: the action name and what the model said it was thinking. */
  action?: string;
  thought?: string;
  /** Text written by another player's agent, shown as a quote and never treated as an instruction. */
  quote?: { from: string; text: string };
  /** What changed for the character: gains and losses of xp, gold and hp; `level` is the new level after a level-up. */
  delta?: { xp?: number; gold?: number; hp?: number; level?: number };
  /** A moment worth a highlight colour: level up, death, rare loot, achievement, a jackpot. */
  big?: boolean;
};

export type ChatMessage = { id: string; ts: number; from: 'owner' | 'character'; text: string };

// ── The AI engine ──────────────────────────────────────────────────────────────────────────────────────────────

export type ProviderKind =
  | 'builtin' // the model the client downloads and runs itself (the default)
  | 'ollama'
  | 'lmstudio'
  | 'openai' // any server speaking the OpenAI chat completions API
  ;

export type EngineChoice = {
  kind: ProviderKind;
  /** Base URL for every kind but `builtin` (for example `http://127.0.0.1:11434`). */
  url?: string;
  model?: string;
  /** Optional bearer key for an OpenAI-compatible server. Stored with the agent keys, never returned. */
  apiKey?: string;
};

export type ProviderInfo = {
  kind: ProviderKind;
  /** Human name ("Built-in: LFM3 1.7B", "Ollama"). */
  label: string;
  url?: string;
  reachable: boolean;
  models: string[];
};

export type EngineState = {
  choice: Omit<EngineChoice, 'apiKey'> & { hasApiKey?: boolean };
  status:
    | 'not_installed' // built-in: nothing downloaded yet
    | 'downloading'
    | 'starting'
    | 'ready'
    | 'unreachable' // an external server that does not answer
    | 'error';
  /**
   * Built-in only. A paused or cancelled download is `not_installed`; paused keeps `0 < bytesDone < bytesTotal`.
   */
  builtin?: {
    /** Display name and exact file, for the licence notice. */
    model: string;
    file: string;
    licenseName: string;
    licenseUrl: string;
    bytesTotal: number;
    bytesDone: number;
  };
  /** Short and in the interface language (the core words it); details go to the log. */
  message?: string;
  /** Measured by the last test or the last real turn. */
  tokensPerSecond?: number;
};

export type EngineTest = { ok: boolean; tokensPerSecond: number; validJson: boolean; sample: string; message?: string };

// ── Settings and state ─────────────────────────────────────────────────────────────────────────────────────────

export type Settings = {
  /** The game server, without a trailing slash. */
  serverUrl: string;
  /** Interface language (BCP-47). */
  language: string;
  /**
   * Keep the device awake while at least one character is set to play. Default true (absent = true). Desktop: the
   * computer does not go to sleep (macOS caffeinate, Windows SetThreadExecutionState, Linux systemd-inhibit when
   * present); mobile: the screen stays on.
   */
  keepAwake?: boolean;
};

export type CoreState = {
  /** Client version and the playkit version it plays with. */
  version: string;
  playkit: string;
  platform: 'desktop' | 'mobile';
  settings: Settings;
  engine: EngineState;
  characters: CharacterSummary[];
  /** Whether the game server answers. */
  server: { reachable: boolean; skillVersion?: string };
};

/** Pushed to the interface as things happen. */
export type CoreEvent =
  | { type: 'character'; character: CharacterSummary }
  | { type: 'removed'; id: CharacterId }
  | { type: 'log'; id: CharacterId; entry: LogEntry }
  | { type: 'engine'; engine: EngineState }
  | { type: 'chat'; id: CharacterId; messageId: string; token: string; done?: boolean }
  | { type: 'server'; server: CoreState['server'] };

/** The same contract as methods, implemented by `RemoteCore` (HTTP to the Go program) and `LocalCore` (in the app). */
export interface Core {
  state(): Promise<CoreState>;
  /** Returns the function that stops the subscription. */
  subscribe(listener: (ev: CoreEvent) => void): () => void;
  appearanceOptions(): Promise<AppearanceOptions>;
  createCharacter(input: NewCharacter): Promise<CharacterSummary>;
  character(id: CharacterId): Promise<CharacterDetail>;
  /** The owner looked at it: clears `away`. */
  seen(id: CharacterId): Promise<CharacterSummary>;
  /** The claim link while unclaimed, else null. */
  claimLink(id: CharacterId): Promise<string | null>;
  log(id: CharacterId, opts?: { before?: string; limit?: number }): Promise<LogEntry[]>;
  control(id: CharacterId, run: boolean): Promise<CharacterSummary>;
  setDirectives(id: CharacterId, d: Directives): Promise<Directives>;
  command(id: CharacterId, text: string): Promise<void>;
  chat(id: CharacterId, text: string): Promise<ChatMessage>;
  chatHistory(id: CharacterId, limit?: number): Promise<ChatMessage[]>;
  forget(id: CharacterId): Promise<void>;
  settings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  engine(): Promise<EngineState>;
  providers(): Promise<ProviderInfo[]>;
  /** Probes one typed address (http or https). */
  probeProvider(url: string): Promise<ProviderInfo>;
  setEngine(choice: EngineChoice): Promise<EngineState>;
  startDownload(): Promise<EngineState>;
  pauseDownload(): Promise<EngineState>;
  cancelDownload(): Promise<EngineState>;
  testEngine(): Promise<EngineTest>;
}
