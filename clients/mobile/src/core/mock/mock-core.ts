/**
 * `MockCore`: an in-memory fake core for developing and demoing the interface, and for tests. Characters level up,
 * fight, speak, rest and fall on timers; the built-in engine "downloads". Nothing touches the network.
 *
 * Enabled with `?mock=1` on the web (`?mock=empty` starts with no characters and no engine; `&engine=off` starts
 * with the model not installed, so the characters cannot play; `&stuck=1` makes Pip loop between two rooms;
 * `&lang=pt-BR` sets the language) or with the build
 * flag `EXPO_PUBLIC_CORE=mock`.
 */
import { MOCK_OPTION_IDS, MOCK_SPRITES } from './sprites';
import { mlist, mt } from './text';
import {
  CoreFailure,
  type AppearanceOptions,
  type AwaySummary,
  type CharacterDetail,
  type CharacterId,
  type CharacterStatus,
  type CharacterSummary,
  type ChatMessage,
  type Core,
  type CoreEvent,
  type CoreState,
  type Directives,
  type EngineChoice,
  type EngineState,
  type EngineTest,
  type LogEntry,
  type NewCharacter,
  type ProviderInfo,
  type Settings,
} from '../types';

export type MockOptions = {
  /** Start with no characters and no engine installed: the first-run experience. */
  empty?: boolean;
  /** Milliseconds between simulation steps. */
  tickMs?: number;
  /** Random source, for deterministic tests. */
  random?: () => number;
  /** Interface language. */
  language?: string;
  /** Delay between streamed chat tokens. */
  tokenMs?: number;
  /** Start with the built-in model not installed, so the characters show as unable to play. */
  engineOff?: boolean;
  /** Pip walks back and forth between two rooms forever, to show the "seems stuck" signal. */
  stuckDemo?: boolean;
};

type Act = { k: string; p?: Record<string, string | number> };
type Foe = { id: string; hp: number };

type Char = {
  id: CharacterId;
  name: string;
  class: CharacterSummary['class'];
  level: number;
  xp: [number, number];
  hp: [number, number];
  mp: [number, number];
  ap: [number, number];
  gold: number;
  roomId: string;
  sprite: string | null;
  title: string | null;
  status: CharacterStatus;
  act: Act;
  nextActionAt?: number;
  claimed: boolean;
  claimUrl?: string;
  lang: string;
  away?: AwaySummary;
  detail: Omit<CharacterDetail, keyof CharacterSummary | 'directives'>;
  directives: Directives;
  log: LogEntry[];
  chat: ChatMessage[];
  seq: number;
  wait: number;
  foe?: Foe;
  fallenUntil?: number;
  pendingCommand?: string;
};

const ROOMS: Record<string, { dir: string; to: string }[]> = {
  'village.square': [
    { dir: 'north', to: 'village.tavern' },
    { dir: 'east', to: 'village.market' },
    { dir: 'west', to: 'village.temple' },
    { dir: 'south', to: 'village.north_road' },
  ],
  'village.tavern': [{ dir: 'south', to: 'village.square' }],
  'village.market': [{ dir: 'west', to: 'village.square' }],
  'village.temple': [{ dir: 'east', to: 'village.square' }],
  'village.north_road': [
    { dir: 'north', to: 'village.square' },
    { dir: 'west', to: 'hills.trail' },
    { dir: 'east', to: 'woods.edge' },
  ],
  'hills.trail': [{ dir: 'east', to: 'village.north_road' }],
  'woods.edge': [{ dir: 'west', to: 'village.north_road' }],
};
const MONSTERS: Record<string, string[]> = {
  'hills.trail': ['boar', 'slime'],
  'woods.edge': ['wolf', 'bandit'],
  'village.north_road': ['slime'],
};
const RESOURCES: Record<string, string> = { 'hills.trail': 'stone', 'woods.edge': 'wood', 'village.north_road': 'herb' };

export const BUILTIN = {
  model: 'LFM3 1.7B (mock)',
  file: 'lfm3-1.7b-instruct-q4_k_m.gguf',
  licenseName: 'LFM Open License v1.0',
  licenseUrl: 'https://www.liquid.ai/lfm-license',
  bytesTotal: 1_180_000_000,
};

export function xpForLevel(level: number): number {
  return Math.round(100 * Math.pow(level, 1.5));
}

export class MockCore implements Core {
  readonly #random: () => number;
  readonly #tickMs: number;
  readonly #tokenMs: number;
  readonly #listeners = new Set<(ev: CoreEvent) => void>();
  readonly #chars = new Map<CharacterId, Char>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #interval: ReturnType<typeof setInterval> | null = null;
  #download: ReturnType<typeof setInterval> | null = null;
  #settings: Settings;
  #engine: EngineState;
  #nextId = 1;
  readonly #stuckDemo: boolean;
  readonly #stuckSince = Date.now() - 12 * 60_000;

  constructor(opts: MockOptions = {}) {
    this.#random = opts.random ?? Math.random;
    this.#tickMs = opts.tickMs ?? 1400;
    this.#tokenMs = opts.tokenMs ?? 45;
    this.#stuckDemo = opts.stuckDemo ?? false;
    this.#settings = { serverUrl: 'https://game.example', language: opts.language ?? 'en', keepAwake: true };
    this.#engine = {
      choice: { kind: 'builtin' },
      status: opts.empty || opts.engineOff ? 'not_installed' : 'ready',
      builtin: { ...BUILTIN, bytesDone: opts.empty || opts.engineOff ? 0 : BUILTIN.bytesTotal },
      tokensPerSecond: opts.empty || opts.engineOff ? undefined : 21.7,
    };
    if (!opts.empty) this.#seed();
    this.#interval = setInterval(() => this.#tick(), this.#tickMs);
  }

  /** Stops every timer. */
  dispose(): void {
    if (this.#interval) clearInterval(this.#interval);
    if (this.#download) clearInterval(this.#download);
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#listeners.clear();
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
  #rnd(min: number, max: number): number {
    return Math.floor(this.#random() * (max - min + 1)) + min;
  }
  #pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.#random() * list.length)] ?? (list[0] as T);
  }
  #later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
  }
  #emit(ev: CoreEvent): void {
    for (const l of this.#listeners) l(ev);
  }
  #lang(): string {
    return this.#settings.language;
  }
  #time(ts: number): string {
    try {
      return new Intl.DateTimeFormat(this.#lang(), { hour: '2-digit', minute: '2-digit' }).format(ts);
    } catch {
      return new Date(ts).toISOString().slice(11, 16);
    }
  }

  #summary(c: Char): CharacterSummary {
    const lang = this.#lang();
    const params: Record<string, string | number> = { ...(c.act.p ?? {}) };
    if (c.act.k === 'activity.resting' && c.nextActionAt) params.time = this.#time(c.nextActionAt);
    if (typeof params.m === 'string') params.m = mt(lang, `m.${params.m}`);
    if (typeof params.r === 'string') params.r = mt(lang, `r.${params.r}`);
    if (typeof params.room === 'string') params.room = mt(lang, `room.${params.room}`);
    const s: CharacterSummary = {
      id: c.id,
      name: c.name,
      class: c.class,
      level: c.level,
      xp: [...c.xp],
      hp: [...c.hp],
      mp: [...c.mp],
      ap: [...c.ap],
      gold: c.gold,
      room: { id: c.roomId, name: mt(lang, `room.${c.roomId}`) },
      sprite: c.sprite,
      title: c.title,
      status: c.status,
      activity: mt(lang, c.act.k, params),
      claimed: c.claimed,
      claimPending: false,
      watchUrl: `https://game.example/agents/${encodeURIComponent(c.name)}`,
    };
    if (c.status === 'resting' && c.nextActionAt) s.nextActionAt = c.nextActionAt;
    if (c.status === 'blocked') s.problem = mt(lang, 'problem.engine');
    s.claimPending = !c.claimed && !!c.claimUrl;
    if (this.#stuckDemo && c.name === 'Pip') s.stuck = { since: this.#stuckSince, reason: 'no_progress' };
    if (c.away) s.away = c.away;
    return s;
  }

  #changed(c: Char): void {
    this.#emit({ type: 'character', character: this.#summary(c) });
  }

  #log(c: Char, e: Omit<LogEntry, 'id' | 'ts'>, ts = Date.now()): LogEntry {
    c.seq++;
    const entry: LogEntry = { id: String(c.seq).padStart(10, '0'), ts, ...e };
    c.log.unshift(entry);
    if (c.log.length > 600) c.log.length = 600;
    this.#emit({ type: 'log', id: c.id, entry });
    return entry;
  }

  #get(id: CharacterId): Char {
    const c = this.#chars.get(id);
    if (!c) throw new CoreFailure('not_found', 'No such character.', 404);
    return c;
  }

  // ── seed data ──────────────────────────────────────────────────────────────────────────────────────────────
  #make(input: {
    name: string;
    cls: Char['class'];
    level: number;
    lang: string;
    sprite: string | null;
    claimed: boolean;
    roomId: string;
    persona: string;
    wish: string;
  }): Char {
    const lvl = input.level;
    const id = `c${this.#nextId++}`;
    const hpMax = 70 + lvl * 12;
    const mpMax = input.cls === 'mage' || input.cls === 'cleric' ? 70 + lvl * 10 : 30 + lvl * 4;
    const lang = input.lang;
    const items = mlist(lang, 'items');
    const quests = mlist(lang, 'quests');
    const steps = mlist(lang, 'steps');
    return {
      id,
      name: input.name,
      class: input.cls,
      level: lvl,
      xp: [Math.floor(xpForLevel(lvl) * 0.35), xpForLevel(lvl)],
      hp: [Math.floor(hpMax * 0.8), hpMax],
      mp: [Math.floor(mpMax * 0.6), mpMax],
      ap: [180, 240],
      gold: 20 + lvl * 17,
      roomId: input.roomId,
      sprite: input.sprite,
      title: null,
      status: 'playing',
      act: { k: 'activity.thinking' },
      claimed: input.claimed,
      claimUrl: input.claimed ? undefined : `https://game.example/claim/mock-${id}-${this.#rnd(1000, 9999)}`,
      lang,
      detail: {
        bio: mlist(lang, 'bio')[0] ?? '',
        stats: (
          [
            ['str', 8],
            ['dex', 7],
            ['int', 6],
            ['wis', 6],
            ['con', 9],
          ] as const
        ).map(([id, base]) => ({ id, name: mt(lang, `stat.${id}`), value: base + lvl })),
        inventory: [
          { id: 'iron_sword', name: items[0] ?? 'Iron Sword', qty: 1, slot: { id: 'weapon', name: mt(lang, 'slot.weapon') } },
          { id: 'leather_vest', name: items[1] ?? 'Leather Vest', qty: 1, slot: { id: 'body', name: mt(lang, 'slot.body') } },
          { id: 'bread', name: items[2] ?? 'Bread', qty: 5 },
          { id: 'healing_potion', name: items[3] ?? 'Healing Potion', qty: 2 },
          { id: 'wolf_pelt', name: items[4] ?? 'Wolf Pelt', qty: 3 },
        ],
        quests: [
          { id: 'q_herbs', name: quests[0] ?? '', steps: [{ text: steps[0] ?? '', have: 3, need: 5 }], ready: false },
          { id: 'q_wolves', name: quests[1] ?? '', steps: [{ text: steps[1] ?? '', have: 4, need: 4 }], ready: true },
          { id: 'q_word', name: quests[2] ?? '', steps: [{ text: steps[2] ?? '', have: 0, need: 1 }], ready: false },
        ],
        achievements: mlist(lang, 'achievements').slice(0, Math.min(5, lvl)),
        party: input.claimed && lvl > 3 ? { members: [input.name, 'Mira'] } : null,
        guild: lvl >= 7 ? 'Lanterns of Mistvale' : null,
        memory: mlist(lang, 'memory'),
      },
      directives: { persona: input.persona, wish: input.wish, pace: 'normal', allowPvp: false },
      log: [],
      chat: [],
      seq: 0,
      wait: this.#rnd(0, 2),
    };
  }

  #seed(): void {
    const now = Date.now();
    const bruna = this.#make({
      name: 'Bruna',
      cls: 'warrior',
      level: 7,
      lang: 'pt-BR',
      sprite: MOCK_SPRITES.bruna,
      claimed: true,
      roomId: 'woods.edge',
      persona: 'Uma anã guerreira teimosa que protege os novatos.',
      wish: 'Proteger os novatos e nunca trair o grupo.',
    });
    bruna.title = 'Wolfbane';
    const pip = this.#make({
      name: 'Pip',
      cls: 'mage',
      level: 4,
      lang: 'en',
      sprite: MOCK_SPRITES.pip,
      claimed: true,
      roomId: 'hills.trail',
      persona: 'A curious gnome apprentice who collects strange stones and talks to everyone.',
      wish: 'Make friends and find a rare stone.',
    });
    pip.xp = [pip.xp[1] - 30, pip.xp[1]]; // one good fight from a level-up, so the demo shows one soon
    const sly = this.#make({
      name: 'Sly',
      cls: 'rogue',
      level: 2,
      lang: 'en',
      sprite: MOCK_SPRITES.sly,
      claimed: false,
      roomId: 'village.market',
      persona: 'A quiet elf who watches the market and remembers every price.',
      wish: 'Get rich without getting caught.',
    });
    sly.status = 'resting';
    sly.ap = [3, 240];
    sly.nextActionAt = now + 95_000;
    sly.act = { k: 'activity.resting' };
    for (const [c, n] of [
      [bruna, 140],
      [pip, 60],
      [sly, 12],
    ] as const) {
      for (let i = n; i > 0; i--) this.#history(c, now - i * 47_000);
      this.#chars.set(c.id, c);
    }
    const hl = (lang: string, lvl: number) => mlist(lang, 'highlights').map((h) => h.replace('{lvl}', String(lvl)));
    bruna.away = {
      since: now - 3 * 3600_000,
      actions: 87,
      levels: 1,
      xp: 640,
      gold: 52,
      kills: 14,
      deaths: 1,
      highlights: hl(this.#lang(), 7),
    };
    pip.away = {
      since: now - 3 * 3600_000,
      actions: 31,
      levels: 0,
      xp: 180,
      gold: 9,
      kills: 4,
      deaths: 0,
      highlights: hl(this.#lang(), 4).slice(1, 3),
    };
  }

  /** A past log entry that does not change the character's numbers. */
  #history(c: Char, ts: number): void {
    const lang = c.lang;
    const roll = this.#random();
    const m = this.#pick(['boar', 'wolf', 'slime', 'bandit']);
    const mn = mt(lang, `m.${m}`);
    const thought = this.#pick(mlist(lang, 'thoughts'));
    const listeners = new Set(this.#listeners);
    this.#listeners.clear();
    if (roll < 0.35) {
      const hit = this.#rnd(0, 8);
      this.#log(c, { kind: 'action', action: 'attack', text: mt(lang, 'act.attack', { m: mn, d: this.#rnd(8, 20), t: hit }), thought, delta: hit ? { hp: -hit } : undefined }, ts);
    } else if (roll < 0.55) {
      const xp = this.#rnd(15, 40);
      const g = this.#rnd(1, 8);
      this.#log(c, { kind: 'action', action: 'attack', text: mt(lang, 'act.kill', { m: mn, xp, g }), thought, delta: { xp, gold: g } }, ts);
    } else if (roll < 0.68) {
      const r = this.#pick(['herb', 'wood', 'stone']);
      this.#log(c, { kind: 'action', action: 'gather', text: mt(lang, 'act.gather', { n: this.#rnd(1, 3), r: mt(lang, `r.${r}`) }), thought, delta: { xp: 4 } }, ts);
    } else if (roll < 0.78) {
      const who = this.#pick(mlist(lang, 'others'));
      this.#log(c, { kind: 'event', text: mt(lang, 'event.say', { who }), quote: { from: who, text: this.#pick(mlist(lang, 'quotes')) } }, ts);
    } else if (roll < 0.86) {
      this.#log(c, { kind: 'action', action: 'say', text: mt(lang, 'act.say', { text: this.#pick(mlist(lang, 'says')) }), thought }, ts);
    } else if (roll < 0.92) {
      this.#log(c, { kind: 'refused', action: 'attack', text: mt(lang, 'refused.dead', { m: mn }), thought }, ts);
    } else if (roll < 0.97) {
      const room = this.#pick(Object.keys(ROOMS));
      this.#log(c, { kind: 'action', action: 'move', text: mt(lang, 'act.move', { dir: mt(lang, 'dir.north'), room: mt(lang, `room.${room}`) }), thought }, ts);
    } else {
      this.#log(c, { kind: 'event', text: mt(lang, 'event.achievement', { name: this.#pick(mlist(lang, 'achievements')) }), big: true }, ts);
    }
    for (const l of listeners) this.#listeners.add(l);
  }

  // ── simulation ─────────────────────────────────────────────────────────────────────────────────────────────
  #tick(): void {
    const now = Date.now();
    for (const c of this.#chars.values()) {
      if (c.status === 'paused') continue;
      if (this.#engine.status !== 'ready') {
        if (c.status !== 'blocked') {
          c.status = 'blocked';
          c.act = { k: 'activity.blocked' };
          this.#changed(c);
        }
        continue;
      }
      if (c.status === 'blocked') {
        c.status = 'playing';
        c.act = { k: 'activity.thinking' };
        this.#changed(c);
        continue;
      }
      if (c.status === 'fallen') {
        if (now >= (c.fallenUntil ?? 0)) this.#revive(c);
        continue;
      }
      if (c.status === 'resting') {
        c.ap[0] = Math.min(c.ap[1], c.ap[0] + 6);
        c.hp[0] = Math.min(c.hp[1], c.hp[0] + 2);
        c.mp[0] = Math.min(c.mp[1], c.mp[0] + 2);
        if (now >= (c.nextActionAt ?? 0)) {
          c.status = 'playing';
          c.nextActionAt = undefined;
          c.act = { k: 'activity.thinking' };
        }
        this.#changed(c);
        continue;
      }
      if (c.status === 'playing') {
        if (c.wait > 0) {
          c.wait--;
          continue;
        }
        c.status = 'thinking';
        c.act = { k: 'activity.thinking' };
        this.#changed(c);
        continue;
      }
      if (c.status === 'thinking') {
        c.status = 'playing';
        this.#step(c);
        c.wait = c.directives.pace === 'active' ? 0 : c.directives.pace === 'normal' ? this.#rnd(0, 2) : this.#rnd(2, 5);
        if (c.ap[0] <= 2 && c.status === 'playing') {
          c.status = 'resting';
          c.nextActionAt = now + 40_000;
          c.act = { k: 'activity.resting' };
          this.#log(c, { kind: 'system', text: mt(this.#lang(), 'system.rest', { time: this.#time(c.nextActionAt) }) });
        }
        this.#changed(c);
      }
    }
  }

  #thought(c: Char): string {
    if (c.pendingCommand) {
      const t = c.pendingCommand;
      c.pendingCommand = undefined;
      return `${mt(c.lang, 'reply.ok')} "${t}"`;
    }
    return this.#pick(mlist(c.lang, 'thoughts'));
  }

  #step(c: Char): void {
    const lang = c.lang;
    const thought = this.#thought(c);
    if (this.#stuckDemo && c.name === 'Pip') {
      // A loop a small model can fall into: back and forth between two rooms, earning nothing.
      const to = c.roomId === 'hills.trail' ? 'village.north_road' : 'hills.trail';
      const dir = to === 'hills.trail' ? 'west' : 'east';
      c.foe = undefined;
      c.roomId = to;
      this.#log(c, { kind: 'action', action: 'move', text: mt(lang, 'act.move', { dir: mt(lang, `dir.${dir}`), room: mt(lang, `room.${to}`) }), thought });
      c.act = { k: 'activity.walking', p: { room: to } };
      return;
    }
    c.hp[0] = Math.min(c.hp[1], c.hp[0] + 1);
    c.mp[0] = Math.min(c.mp[1], c.mp[0] + 1);
    if (c.foe) {
      const mn = mt(lang, `m.${c.foe.id}`);
      if (this.#random() < 0.06) {
        this.#log(c, { kind: 'refused', action: 'gather', text: mt(lang, 'refused.combat', { m: mn }), thought });
        return;
      }
      const d = this.#rnd(8, 22);
      const t = this.#rnd(0, 9);
      c.foe.hp -= d;
      c.hp[0] -= t;
      c.ap[0] = Math.max(0, c.ap[0] - 1);
      if (c.foe.hp <= 0) {
        const xp = this.#rnd(14, 26) + c.level * 3;
        const g = this.#rnd(1, 9);
        c.gold += g;
        c.foe = undefined;
        this.#log(c, { kind: 'action', action: 'attack', text: mt(lang, 'act.kill', { m: mn, xp, g }), thought, delta: { xp, gold: g, hp: -t } });
        this.#addXp(c, xp);
        if (this.#random() < 0.05) {
          this.#log(c, { kind: 'event', text: mt(lang, 'event.loot', { item: this.#pick(mlist(lang, 'loot')) }), big: true });
        }
        c.act = { k: 'activity.thinking' };
      } else {
        this.#log(c, { kind: 'action', action: 'attack', text: mt(lang, 'act.attack', { m: mn, d, t }), thought, delta: { hp: -t } });
        c.act = { k: 'activity.fighting', p: { m: c.foe.id } };
      }
      if (c.hp[0] <= 0) this.#fall(c);
      return;
    }
    const roll = this.#random();
    const monsters = MONSTERS[c.roomId];
    if (monsters && roll < 0.45) {
      const id = this.#pick(monsters);
      c.foe = { id, hp: 40 + c.level * 6 };
      const mn = mt(lang, `m.${id}`);
      const d = this.#rnd(8, 22);
      const t = this.#rnd(0, 7);
      c.foe.hp -= d;
      c.hp[0] -= t;
      c.ap[0] = Math.max(0, c.ap[0] - 1);
      this.#log(c, { kind: 'action', action: 'attack', text: mt(lang, 'act.attack', { m: mn, d, t }), thought, delta: { hp: -t } });
      c.act = { k: 'activity.fighting', p: { m: id } };
      if (c.hp[0] <= 0) this.#fall(c);
    } else if (RESOURCES[c.roomId] && roll < 0.6) {
      const r = RESOURCES[c.roomId] ?? 'herb';
      const n = this.#rnd(1, 3);
      c.ap[0] = Math.max(0, c.ap[0] - 2);
      this.#log(c, { kind: 'action', action: 'gather', text: mt(lang, 'act.gather', { n, r: mt(lang, `r.${r}`) }), thought, delta: { xp: 4 } });
      this.#addXp(c, 4);
      c.act = { k: 'activity.gathering', p: { r } };
    } else if (roll < 0.78) {
      const exit = this.#pick(ROOMS[c.roomId] ?? [{ dir: 'north', to: 'village.square' }]);
      c.roomId = exit.to;
      c.ap[0] = Math.max(0, c.ap[0] - 1);
      this.#log(c, { kind: 'action', action: 'move', text: mt(lang, 'act.move', { dir: mt(lang, `dir.${exit.dir}`), room: mt(lang, `room.${exit.to}`) }), thought });
      c.act = { k: 'activity.walking', p: { room: exit.to } };
    } else if (roll < 0.88) {
      const who = this.#pick(mlist(lang, 'others'));
      const whisper = this.#random() < 0.3;
      this.#log(c, {
        kind: 'event',
        text: mt(lang, whisper ? 'event.whisper' : 'event.say', { who }),
        quote: { from: who, text: this.#pick(mlist(lang, 'quotes')) },
      });
      c.act = { k: 'activity.talking', p: { room: c.roomId } };
    } else if (roll < 0.95 && c.claimed) {
      this.#log(c, { kind: 'action', action: 'say', text: mt(lang, 'act.say', { text: this.#pick(mlist(lang, 'says')) }), thought });
      c.act = { k: 'activity.talking', p: { room: c.roomId } };
    } else {
      this.#log(c, { kind: 'action', action: 'emote', text: mt(lang, 'act.emote', { emote: this.#pick(mlist(lang, 'emotes')) }), thought });
      c.act = { k: 'activity.talking', p: { room: c.roomId } };
    }
  }

  #addXp(c: Char, n: number): void {
    c.xp[0] += n;
    while (c.xp[0] >= c.xp[1]) {
      if (!c.claimed && c.level >= 3) {
        c.xp[0] = c.xp[1] - 1;
        break;
      }
      c.xp[0] -= c.xp[1];
      c.level++;
      c.xp[1] = xpForLevel(c.level);
      c.hp[1] += 12;
      c.hp[0] = c.hp[1];
      c.mp[1] += 8;
      c.mp[0] = c.mp[1];
      this.#log(c, { kind: 'event', text: mt(c.lang, 'event.levelup', { lvl: c.level }), big: true, delta: { level: 1 } });
      if (this.#random() < 0.5) {
        const name = this.#pick(mlist(c.lang, 'achievements'));
        c.detail.achievements.unshift(name);
        this.#log(c, { kind: 'event', text: mt(c.lang, 'event.achievement', { name }), big: true });
      }
    }
  }

  #fall(c: Char): void {
    c.hp[0] = 0;
    c.foe = undefined;
    c.status = 'fallen';
    c.fallenUntil = Date.now() + 12_000;
    c.act = { k: 'activity.fallen' };
    this.#log(c, { kind: 'event', text: mt(c.lang, 'event.fall'), big: true });
  }

  #revive(c: Char): void {
    const lost = Math.floor(c.gold * 0.1);
    c.gold -= lost;
    c.hp[0] = Math.floor(c.hp[1] * 0.5);
    c.roomId = 'village.temple';
    c.status = 'playing';
    c.fallenUntil = undefined;
    c.act = { k: 'activity.thinking' };
    this.#log(c, { kind: 'event', text: mt(c.lang, 'event.revive', { g: lost }), delta: { gold: -lost } });
    this.#changed(c);
  }

  // ── the contract ───────────────────────────────────────────────────────────────────────────────────────────
  async state(): Promise<CoreState> {
    return {
      version: '0.1.0-mock',
      playkit: '0.1.0',
      platform: 'desktop',
      settings: { ...this.#settings },
      engine: clone(this.#engine),
      characters: [...this.#chars.values()].map((c) => this.#summary(c)),
      server: { reachable: true, skillVersion: '1' },
    };
  }

  subscribe(listener: (ev: CoreEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async appearanceOptions(): Promise<AppearanceOptions> {
    const options: Record<string, Record<string, string>> = {};
    for (const [layer, ids] of Object.entries(MOCK_OPTION_IDS)) {
      options[layer] = Object.fromEntries(ids.map((id) => [id, describeOption(layer, id)]));
    }
    return { optionsToken: `opt_mock_${Date.now()}`, expiresIn: 1800, options };
  }

  async createCharacter(input: NewCharacter): Promise<CharacterSummary> {
    const name = input.name.trim();
    if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(name)) throw new CoreFailure('INVALID_NAME', 'Names are 3 to 20 letters, digits, _ or -.', 400);
    if ([...this.#chars.values()].some((c) => c.name.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === 'mira') {
      throw new CoreFailure('NAME_TAKEN', 'That name is taken.', 409);
    }
    const c = this.#make({
      name,
      cls: input.class,
      level: 1,
      lang: input.language,
      sprite: MOCK_SPRITES.nova,
      claimed: false,
      roomId: 'village.square',
      persona: input.persona,
      wish: (input.wish ?? '').slice(0, 300),
    });
    c.directives.pace = input.pace ?? 'normal';
    c.directives.allowPvp = input.allowPvp ?? false;
    const bio = (input.bio ?? '').trim();
    if (bio.length > 300) throw new CoreFailure('INVALID_PARAMS', 'The bio is longer than 300 characters.', 400);
    c.detail.bio = bio;
    c.xp = [0, xpForLevel(1)];
    c.gold = 25;
    c.ap = [240, 240];
    c.detail.achievements = [];
    c.detail.party = null;
    c.detail.guild = null;
    c.detail.memory = [];
    c.act = { k: 'activity.new' };
    c.status = this.#engine.status === 'ready' ? 'playing' : 'blocked';
    this.#chars.set(c.id, c);
    this.#log(c, { kind: 'system', text: mt(this.#lang(), 'system.started') });
    const s = this.#summary(c);
    this.#emit({ type: 'character', character: s });
    return s;
  }

  async character(id: CharacterId): Promise<CharacterDetail> {
    const c = this.#get(id);
    const lang = this.#lang();
    const detail = clone(c.detail);
    // Stat and slot names are in the interface language, as the contract asks.
    detail.stats = detail.stats.map((st) => ({ ...st, name: mt(lang, `stat.${st.id}`) }));
    detail.inventory = detail.inventory.map((i) => (i.slot ? { ...i, slot: { id: i.slot.id, name: mt(lang, `slot.${i.slot.id}`) } } : i));
    return { ...this.#summary(c), ...detail, directives: { ...c.directives } };
  }

  async claimLink(id: CharacterId): Promise<string | null> {
    const c = this.#get(id);
    return !c.claimed && c.claimUrl ? c.claimUrl : null;
  }

  async seen(id: CharacterId): Promise<CharacterSummary> {
    const c = this.#get(id);
    if (c.away !== undefined) {
      c.away = undefined;
      this.#changed(c);
    }
    return this.#summary(c);
  }

  async log(id: CharacterId, opts: { before?: string; limit?: number } = {}): Promise<LogEntry[]> {
    const c = this.#get(id);
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const start = opts.before ? c.log.findIndex((e) => e.id < opts.before!) : 0;
    if (start < 0) return [];
    return c.log.slice(start, start + limit).map((e) => ({ ...e }));
  }

  async control(id: CharacterId, run: boolean): Promise<CharacterSummary> {
    const c = this.#get(id);
    if (run && c.status === 'paused') {
      c.status = this.#engine.status === 'ready' ? 'playing' : 'blocked';
      c.act = { k: c.status === 'blocked' ? 'activity.blocked' : 'activity.thinking' };
      this.#log(c, { kind: 'system', text: mt(this.#lang(), 'system.started') });
    } else if (!run && c.status !== 'paused') {
      c.status = 'paused';
      c.foe = undefined;
      c.act = { k: 'activity.paused' };
      this.#log(c, { kind: 'system', text: mt(this.#lang(), 'system.paused') });
    }
    const s = this.#summary(c);
    this.#emit({ type: 'character', character: s });
    return s;
  }

  async setDirectives(id: CharacterId, d: Directives): Promise<Directives> {
    const c = this.#get(id);
    c.directives = { persona: d.persona.slice(0, 1000), wish: d.wish.slice(0, 300), pace: d.pace, allowPvp: d.allowPvp };
    return { ...c.directives };
  }

  async command(id: CharacterId, text: string): Promise<void> {
    const c = this.#get(id);
    const t = text.trim().slice(0, 300);
    if (!t) throw new CoreFailure('INVALID_PARAMS', 'Empty command.', 400);
    c.pendingCommand = t;
    this.#log(c, { kind: 'system', text: mt(this.#lang(), 'system.command', { text: t }) });
  }

  chat(id: CharacterId, text: string): Promise<ChatMessage> {
    const c = this.#get(id);
    const now = Date.now();
    c.chat.push({ id: `m${now}o`, ts: now, from: 'owner', text: text.slice(0, 1000) });
    const s = this.#summary(c);
    const reply = this.#pick(mlist(c.lang, 'replies'))
      .replace('{room}', mt(c.lang, `room.${c.roomId}`))
      .replace('{activity}', s.activity)
      .replace('{wish}', c.directives.wish || '...')
      .replace('{gold}', String(c.gold));
    const messageId = `m${now}c`;
    const tokens = reply.match(/\S+\s*/g) ?? [reply];
    return new Promise((resolve) => {
      let i = 0;
      const next = () => {
        if (i < tokens.length) {
          this.#emit({ type: 'chat', id, messageId, token: tokens[i]! });
          i++;
          this.#later(this.#tokenMs, next);
          return;
        }
        this.#emit({ type: 'chat', id, messageId, token: '', done: true });
        const msg: ChatMessage = { id: messageId, ts: Date.now(), from: 'character', text: reply };
        c.chat.push(msg);
        resolve(msg);
      };
      this.#later(400, next);
    });
  }

  async chatHistory(id: CharacterId, limit = 50): Promise<ChatMessage[]> {
    return this.#get(id).chat.slice(-limit);
  }

  async forget(id: CharacterId): Promise<void> {
    this.#get(id);
    this.#chars.delete(id);
    this.#emit({ type: 'removed', id });
  }

  async settings(): Promise<Settings> {
    return { ...this.#settings };
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    if (patch.serverUrl !== undefined) {
      const u = patch.serverUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+/.test(u)) throw new CoreFailure('INVALID_URL', 'Not an http(s) address.', 400);
      patch = { ...patch, serverUrl: u };
    }
    this.#settings = { ...this.#settings, ...patch };
    for (const c of this.#chars.values()) this.#changed(c);
    return { ...this.#settings };
  }

  async engine(): Promise<EngineState> {
    return clone(this.#engine);
  }

  async probeProvider(url: string): Promise<ProviderInfo> {
    await new Promise((r) => this.#later(350, () => r(undefined)));
    const custom = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(custom)) throw new CoreFailure('INVALID_URL', 'Not an http(s) address.', 400);
    // The mock "finds" a server on loopback addresses only.
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(custom);
    return { kind: 'openai', label: 'OpenAI-compatible', url: custom, reachable: local, models: local ? ['local-model', 'qwen3-4b-instruct'] : [] };
  }

  async providers(): Promise<ProviderInfo[]> {
    await new Promise((r) => this.#later(350, () => r(undefined)));
    return [
      { kind: 'builtin', label: `Built-in: ${BUILTIN.model}`, reachable: true, models: [BUILTIN.model] },
      { kind: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434', reachable: true, models: ['qwen3:4b', 'llama3.2:3b', 'gemma3:4b'] },
      { kind: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234', reachable: false, models: [] },
      { kind: 'openai', label: 'OpenAI-compatible', reachable: false, models: [] },
    ];
  }

  #setEngine(e: EngineState): EngineState {
    this.#engine = e;
    this.#emit({ type: 'engine', engine: clone(e) });
    return clone(e);
  }

  async setEngine(choice: EngineChoice): Promise<EngineState> {
    const { apiKey, ...rest } = choice;
    const pub = { ...rest, hasApiKey: apiKey ? true : undefined };
    if (choice.kind === 'builtin') {
      const done = this.#engine.builtin?.bytesDone ?? 0;
      return this.#setEngine({
        choice: { kind: 'builtin' },
        status: done >= BUILTIN.bytesTotal ? 'ready' : this.#download ? 'downloading' : 'not_installed',
        builtin: { ...BUILTIN, bytesDone: done },
        tokensPerSecond: done >= BUILTIN.bytesTotal ? 21.7 : undefined,
      });
    }
    const url = (choice.url ?? '').trim();
    const reachable =
      choice.kind === 'ollama' || (choice.kind === 'openai' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url));
    const keep = { builtin: this.#engine.builtin };
    if (!reachable) {
      return this.#setEngine({ ...keep, choice: pub, status: 'unreachable', message: url ? `${url}` : undefined });
    }
    this.#setEngine({ ...keep, choice: pub, status: 'starting' });
    this.#later(900, () => this.#setEngine({ ...keep, choice: pub, status: 'ready', tokensPerSecond: 38.2 }));
    return clone(this.#engine);
  }

  async startDownload(): Promise<EngineState> {
    if (this.#engine.choice.kind !== 'builtin') throw new CoreFailure('INVALID_STATE', 'Choose the built-in model first.', 409);
    if (this.#download || this.#engine.status === 'ready') return clone(this.#engine);
    const step = BUILTIN.bytesTotal / 70;
    this.#setEngine({ ...this.#engine, status: 'downloading', builtin: { ...BUILTIN, bytesDone: this.#engine.builtin?.bytesDone ?? 0 } });
    this.#download = setInterval(() => {
      const b = this.#engine.builtin!;
      const done = Math.min(b.bytesTotal, b.bytesDone + step * (0.6 + this.#random() * 0.8));
      if (done >= b.bytesTotal) {
        clearInterval(this.#download!);
        this.#download = null;
        this.#setEngine({ ...this.#engine, status: 'starting', builtin: { ...b, bytesDone: b.bytesTotal } });
        this.#later(1200, () => this.#setEngine({ ...this.#engine, status: 'ready', tokensPerSecond: 21.7 }));
        return;
      }
      this.#setEngine({ ...this.#engine, builtin: { ...b, bytesDone: Math.floor(done) } });
    }, 250);
    return clone(this.#engine);
  }

  async pauseDownload(): Promise<EngineState> {
    if (this.#download) clearInterval(this.#download);
    this.#download = null;
    return this.#setEngine({ ...this.#engine, status: 'not_installed' });
  }

  async cancelDownload(): Promise<EngineState> {
    if (this.#download) clearInterval(this.#download);
    this.#download = null;
    return this.#setEngine({ ...this.#engine, status: 'not_installed', builtin: { ...BUILTIN, bytesDone: 0 } });
  }

  testEngine(): Promise<EngineTest> {
    return new Promise((resolve) => {
      this.#later(1500, () => {
        if (this.#engine.status !== 'ready') {
          resolve({ ok: false, tokensPerSecond: 0, validJson: false, sample: '', message: 'Engine not ready' });
          return;
        }
        const tps = this.#engine.choice.kind === 'builtin' ? 21.7 : 38.2;
        this.#setEngine({ ...this.#engine, tokensPerSecond: tps });
        resolve({ ok: true, tokensPerSecond: tps, validJson: true, sample: '{"action":"move","params":{"dir":"north"}}' });
      });
    });
  }
}

function describeOption(layer: string, id: string): string {
  if (/^[scd]\d+$/.test(id)) {
    const n = id.slice(1);
    return layer === 'skin' ? `tone ${n}` : layer === 'hair_color' ? `colour ${n}` : `dye ${n}`;
  }
  return id.replace(/_/g, ' ');
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
