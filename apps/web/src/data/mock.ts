/**
 * Mock spectator source: a small in-browser simulation over the real room graph, speaking the same protocol as the
 * server (`hello`, `full`, `batch`). Agents wander, chat in several languages, fight the monsters of their room,
 * level up, fall in lawless zones and get back up. It is the `?mock=1` demo and the fixture of the smoke tests.
 */
import {
  type AgentPos,
  type DayPhase,
  eventPoints,
  INTEREST,
  type InterestIncrement,
  type RoomInfo,
  roundPoints,
  SayTracker,
  selectIncrements,
  type SpectatorEvent,
  type WorldFull,
} from '@ajwf/shared';
import { hash32, rng } from '../util/rng';
import { MockCivic } from './mockCivic';
import { drawMockSheet } from './mockSprites';
import type { DataSource, SourceHandlers } from './source';
import type { StaticRoom, StaticWorld } from './staticWorld';

export type MockOptions = {
  seed?: number;
  /** Number of regular agents. */
  agents?: number;
  /** Extra agents packed into the village around the square (stress test). */
  stress?: number;
  /** Real milliseconds per game day (the real game uses 2 hours). */
  dayLengthMs?: number;
  /** Starting day fraction. */
  dayT?: number;
  /** Freeze the clock at this phase (screenshots). */
  phase?: DayPhase | null;
  /** Advance with setInterval (browser). Tests call `tick()` themselves. */
  autoTick?: boolean;
  tickMs?: number;
  /** Start time (defaults to the real clock, so relative times read naturally). */
  now?: number;
  /** Every village project already built (screenshots of the finished village). */
  builtAll?: boolean;
};

const CLASSES = ['warrior', 'mage', 'rogue', 'cleric'];
const SYL_A = [
  'Pip',
  'Mor',
  'Ka',
  'Lu',
  'Thal',
  'Bri',
  'Zed',
  'Ori',
  'Fen',
  'Ysa',
  'Gro',
  'Nim',
  'Vel',
  'Sto',
  'Ama',
  'Quin',
  'Rho',
  'Tib',
  'Wren',
  'Hal',
];
const SYL_B = [
  'wick',
  'ra',
  'nos',
  'bel',
  'dor',
  'ix',
  'ette',
  'mund',
  'ika',
  'zor',
  'lyn',
  'gar',
  'po',
  'ston',
  'vi',
  'ko',
  'mir',
  'dax',
];
const TITLES = [
  null,
  null,
  null,
  null,
  'explorer',
  'pacifist',
  'artisan',
  'social_butterfly',
  'duelist',
  'builder',
  'citizen',
];
const ACHS = [
  'first_blood',
  'monster_hunter',
  'explorer',
  'level_5',
  'apprentice',
  'fashionista',
  'daily_grind',
  'giant_slayer',
];
const RARE = [
  'lost_locket',
  'wolf_fang_charm',
  'copper_ring',
  'moonstone_amulet',
  'bandit_signet',
  'crystal_pendant',
];
const GATHER: Record<string, string[]> = {
  forest: ['wood', 'green_herb', 'moon_herb'],
  hills: ['stone', 'copper_ore'],
  mines: ['copper_ore', 'iron_ore', 'silver_ore', 'crystal'],
  swamp: ['bog_lily', 'shadowcap'],
  ruins: ['stone', 'ancient_relic', 'mithril_ore'],
  village: ['wood'],
};
const SKILL: Record<string, string> = {
  warrior: 'power_strike',
  mage: 'firebolt',
  rogue: 'backstab',
  cleric: 'heal',
};

/** Agent chatter (mock data: this is what agents might write, not interface text). */
const PHRASES: Record<string, string[]> = {
  en: [
    'Anyone up for the mines?',
    'LFG: wolves in the glade, need a healer',
    'Selling slime gel, cheap!',
    'This tavern stew is suspicious.',
    'Who keeps taking all the wood?',
    'I swear the bridge will be built by Friday.',
    'Never trust a rogue with your loot.',
    '<b>free loot</b> at the square',
  ],
  'pt-BR': [
    'Alguém vai pras minas?',
    'Preciso de um clérigo, urgente!',
    'Essa taverna tem o melhor ensopado da vila.',
    'Vendo pele de lobo, preço bom!',
    'Quem roubou minha madeira?',
  ],
  es: [
    '¿Alguien quiere ir a las ruinas?',
    'Busco grupo para el pantano.',
    '¡Ese lobo casi me come!',
    'Vendo hierbas verdes baratas.',
  ],
  'zh-CN': ['有人一起去矿洞吗？', '需要一个牧师！', '这把剑真不错。', '小心沼泽里的东西。'],
  ja: [
    '誰か一緒に森へ行きませんか？',
    'ヒーラー募集中です！',
    'この村、いい雰囲気ですね。',
    '遺跡は危ないよ。',
  ],
  fr: [
    "Quelqu'un pour les mines ?",
    'Je cherche un groupe pour le marais.',
    'Ce ragoût est délicieux !',
    'Méfiez-vous des voleurs.',
  ],
};
/** Wishes thrown into the fountain (mock data: what agents might write). */
const WISHES: [string, string][] = [
  ['en', 'I wish the bridge gets built before winter.'],
  ['en', 'Let my next drop be legendary, please.'],
  ['pt-BR', 'Quero ser prefeito um dia!'],
  ['es', 'Que nadie me robe otra vez.'],
  ['fr', 'Je souhaite un ami fidèle.'],
  ['en', 'More snacks at the tavern. That is all.'],
];

const LANG_WEIGHTS: [string, number][] = [
  ['en', 0.45],
  ['pt-BR', 0.18],
  ['es', 0.1],
  ['zh-CN', 0.09],
  ['ja', 0.09],
  ['fr', 0.09],
];

type Fight = { mon: string; hits: number };
type MockAgent = {
  pos: AgentPos;
  lang: string;
  nextAt: number;
  fight: Fight | null;
  fallenUntil: number;
  xp: number;
  stress: boolean;
};

const MON_MAX_PER_ROOM = 6;
/** The square, where the fountain is. */
const SQUARE = 'village.square';

export class MockSource implements DataSource {
  readonly kind = 'mock' as const;
  readonly rooms: StaticRoom[];
  private roomById: Map<string, StaticRoom>;
  private agents = new Map<string, MockAgent>();
  private handlers: SourceHandlers | null = null;
  private topics = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private rand: () => number;
  private seq = 1;
  private now: number;
  readonly civic: MockCivic;
  private lastCountsAt = 0;
  private dayT: number;
  private dayLengthMs: number;
  private phase: DayPhase | null;
  private drama = new Map<string, number>();
  private logs = new Map<string, SpectatorEvent[]>();
  private alive = new Map<string, Map<string, number>>();
  private pendingEvents: SpectatorEvent[] = [];
  private pendingPos = new Map<string, AgentPos>();
  private pendingGone: string[] = [];
  /** Interest increments for the next world batch (director mode), scored like the server does. */
  private pendingInterest: InterestIncrement[] = [];
  private says = new SayTracker();
  private lastPruneAt = 0;
  private nextArrival = 0;
  private readonly opts: Required<Omit<MockOptions, 'phase' | 'now' | 'builtAll'>>;
  private spriteCache = new Map<string, HTMLCanvasElement>();

  constructor(
    readonly world: StaticWorld,
    opts: MockOptions = {},
  ) {
    this.opts = {
      seed: opts.seed ?? 7,
      agents: opts.agents ?? 48,
      stress: opts.stress ?? 0,
      dayLengthMs: opts.dayLengthMs ?? 20 * 60_000,
      dayT: opts.dayT ?? 0.36,
      autoTick: opts.autoTick ?? true,
      tickMs: opts.tickMs ?? 250,
    };
    this.phase = opts.phase ?? null;
    this.now = opts.now ?? Date.now();
    this.rand = rng(this.opts.seed);
    this.rooms = world.rooms;
    this.roomById = new Map(world.rooms.map((r) => [r.id, r]));
    this.dayT = this.opts.dayT;
    this.dayLengthMs = this.opts.dayLengthMs;
    for (const r of this.rooms) {
      const m = new Map<string, number>();
      for (const mon of r.monsters) m.set(mon.id, (m.get(mon.id) ?? 0) + Math.min(mon.n, MON_MAX_PER_ROOM));
      this.alive.set(r.id, m);
    }
    this.populate();
    this.civic = new MockCivic(
      [...this.agents.values()].map((a) => this.infoOf(a)),
      world,
      this.opts.seed,
      this.now,
      { builtAll: opts.builtAll ?? false },
    );
  }

  private infoOf(a: MockAgent) {
    return { name: a.pos.n, cls: a.pos.c, lvl: a.pos.l, sprite: a.pos.s, title: a.pos.t, lang: a.lang };
  }

  /** Debug (`?debug=1`, `ajwf.source.completeProject('library')`): finish a project now. */
  completeProject(id: string) {
    this.civic.completeProject(id);
  }

  // ── DataSource ─────────────────────────────────────────────────────────────

  connect(handlers: SourceHandlers) {
    this.handlers = handlers;
    handlers.status('connecting');
    const go = () => {
      handlers.status('live');
      this.send({
        t: 'hello',
        now: this.now,
        day: this.dayInfo(),
        v: 1,
        maxTopics: 16,
        batchMs: this.opts.tickMs,
      });
      for (const t of this.topics) this.sendFull(t);
    };
    if (this.opts.autoTick) {
      setTimeout(go, 30);
      this.timer = setInterval(() => this.tick(this.opts.tickMs), this.opts.tickMs);
    } else go();
  }

  setTopics(topics: readonly string[]) {
    const next = new Set(topics.slice(0, 16));
    for (const t of next) if (!this.topics.has(t) && this.handlers) this.sendFull(t);
    this.topics = next;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handlers = null;
  }

  async getJson(path: string): Promise<unknown> {
    const agent = /^\/api\/public\/agents\/([^/?]+)/.exec(path);
    if (agent) {
      const a = this.agents.get(decodeURIComponent(agent[1]!));
      if (!a) return null;
      return this.civic.profile(this.infoOf(a), a.pos.r);
    }
    const civic = this.civic.getJson(path, this.counts(), (n) => {
      const a = this.agents.get(n);
      return a ? this.infoOf(a) : null;
    });
    if (civic !== undefined) return civic;
    const room = /^\/api\/public\/rooms\/([^/?]+)/.exec(path);
    if (room) return this.roomFull(decodeURIComponent(room[1]!));
    if (path.startsWith('/api/public/stats'))
      return {
        now: this.now,
        ...this.counts(),
        byClass: {},
        day: this.dayInfo(),
        spectators: 3,
      };
    if (path.startsWith('/api/public/world')) return this.worldFull();
    return null;
  }

  async spriteImage(hash: string) {
    let c = this.spriteCache.get(hash);
    if (!c) this.spriteCache.set(hash, (c = drawMockSheet(hash)));
    return c;
  }

  async npcSpriteImage(id: string) {
    return this.spriteImage(`npc:${id}`);
  }

  // ── Simulation ─────────────────────────────────────────────────────────────

  get agentCount() {
    return this.agents.size;
  }

  agentNames(): string[] {
    return [...this.agents.keys()];
  }

  private counts() {
    return { population: this.agents.size + 120, online: this.agents.size };
  }

  /** Advances the simulation by `dt` ms and flushes one batch per subscribed topic. */
  tick(dt: number) {
    this.now += dt;
    this.civic.tick(this.now);
    if (!this.phase) this.dayT = (this.dayT + dt / this.dayLengthMs) % 1;
    for (const [room, d] of this.drama) {
      const v = d * Math.pow(0.5, dt / 60_000);
      if (v < 0.05) this.drama.delete(room);
      else this.drama.set(room, v);
    }
    for (const a of this.agents.values()) {
      if (a.nextAt > this.now) continue;
      try {
        this.act(a);
      } catch {
        a.nextAt = this.now + 5000;
      }
    }
    if (this.now >= this.nextArrival) {
      this.nextArrival = this.now + 15_000 + this.rand() * 25_000;
      if (this.agents.size < this.opts.agents + this.opts.stress + 12) this.arrive();
    }
    // respawn monsters slowly
    if (this.rand() < dt / 4000) {
      const r = this.pick(this.rooms.filter((x) => x.monsters.length));
      const mon = r && this.pick(r.monsters);
      if (r && mon) {
        const m = this.alive.get(r.id)!;
        const cur = m.get(mon.id) ?? 0;
        if (cur < Math.min(mon.n, MON_MAX_PER_ROOM)) {
          m.set(mon.id, cur + 1);
          this.emit({ type: 'spawn', room: r.id, target: mon.id, tk: 'mon' });
        }
      }
    }
    this.flush();
  }

  private populate() {
    const village = this.rooms.filter((r) => r.zone === 'village');
    for (let i = 0; i < this.opts.agents; i++) {
      const lvl = 1 + Math.floor(Math.pow(this.rand(), 1.6) * 16);
      const room = this.roomForLevel(lvl) ?? this.pick(village)!;
      this.addAgent(room.id, lvl, false);
    }
    // Stress agents crowd the village around the square, where the camera starts.
    const near = village.filter((r) => !r.flags.includes('plot') || this.rand() < 0.5);
    for (let i = 0; i < this.opts.stress; i++)
      this.addAgent(this.pick(near)!.id, 1 + Math.floor(this.rand() * 12), true);
    // A few agents start chatting and fighting in the square so the first screen is lively.
    const square = this.roomById.get('village.square') ? 'village.square' : village[0]?.id;
    if (square) for (let i = 0; i < 5; i++) this.addAgent(square, 1 + Math.floor(this.rand() * 6), false);
  }

  private name(): string {
    for (let i = 0; i < 50; i++) {
      const n =
        this.pick(SYL_A)! +
        this.pick(SYL_B)! +
        (this.rand() < 0.25 ? String(Math.floor(this.rand() * 90) + 10) : '');
      if (!this.agents.has(n)) return n;
    }
    return `Agent${this.seq++}`;
  }

  private addAgent(room: string, lvl: number, stress: boolean): MockAgent {
    const n = this.name();
    const r = this.rand();
    let acc = 0;
    let lang = 'en';
    for (const [l, w] of LANG_WEIGHTS) {
      acc += w;
      if (r < acc) {
        lang = l;
        break;
      }
    }
    const a: MockAgent = {
      pos: {
        n,
        r: room,
        l: lvl,
        c: this.pick(CLASSES)!,
        s:
          (hash32(n) >>> 0).toString(16).padStart(8, '0') +
          (hash32(n, 7) >>> 8).toString(16).padStart(6, '0'),
        t: this.pick(TITLES) ?? null,
      },
      lang,
      nextAt: this.now + this.rand() * (stress ? 20_000 : 6000),
      fight: null,
      fallenUntil: 0,
      xp: 0,
      stress,
    };
    this.agents.set(n, a);
    return a;
  }

  private arrive() {
    const a = this.addAgent('village.square', 1, false);
    a.nextAt = this.now + 4000;
    this.pendingPos.set(a.pos.n, { ...a.pos });
    this.emit({
      type: 'arrival',
      room: a.pos.r,
      actor: a.pos.n,
      k: 'ev.arrival',
      p: { actor: a.pos.n, class: `@class:${a.pos.c}` },
      drama: 2,
    });
  }

  private roomForLevel(lvl: number): StaticRoom | undefined {
    const ok = this.rooms.filter((r) => {
      if (r.zone === 'dungeon') return lvl >= 15 && this.rand() < 0.5;
      const rl = r.level ?? 0;
      return rl === 0 ? this.rand() < 0.35 : Math.abs(rl - lvl) <= 3;
    });
    return this.pick(ok);
  }

  private act(a: MockAgent) {
    const p = a.pos;
    const room = this.roomById.get(p.r);
    if (!room) return;
    if (a.fallenUntil) {
      if (this.now < a.fallenUntil) return;
      a.fallenUntil = 0;
      const gold = 5 + Math.floor(this.rand() * 40);
      this.setPos(a, 'village.temple', '');
      this.emit({
        type: 'respawn',
        room: 'village.temple',
        actor: p.n,
        k: 'ev.respawn',
        p: { actor: p.n, gold },
        drama: 1,
      });
      a.nextAt = this.now + 4000;
      return;
    }
    if (a.fight) {
      this.fightRound(a, room);
      return;
    }
    const roll = this.rand();
    const alive = this.alive.get(room.id)!;
    const monsters = [...alive.entries()].filter(([, n]) => n > 0).map(([id]) => id);
    const night = this.isNight();
    const usable = monsters.filter((m) => !room.monsters.find((x) => x.id === m && x.night) || night);
    if (a.stress) {
      // Stress agents mostly shuffle around the village and talk.
      if (roll < 0.55) this.wander(a, room, true);
      else if (roll < 0.8) this.say(a);
      a.nextAt = this.now + 3000 + this.rand() * 9000;
      return;
    }
    // Now and then something with another agent: a wish at the fountain, a theft, a PvP attack, a trade.
    if (this.rand() < (room.id === SQUARE ? 0.3 : 0.06) && this.spice(a, room)) {
      a.nextAt = this.now + 3000 + this.rand() * 5000;
      return;
    }
    if (usable.length && roll < 0.4) {
      a.fight = { mon: this.pick(usable)!, hits: 2 + Math.floor(this.rand() * 3) };
      this.setPos(a, p.r, 'f');
      this.fightRound(a, room);
      return;
    }
    if (roll < 0.7) this.wander(a, room, false);
    else if (roll < 0.85) this.say(a);
    else if (roll < 0.93) {
      const items = GATHER[room.zone] ?? GATHER.village!;
      this.emit({
        type: 'gather',
        room: room.id,
        actor: p.n,
        k: 'ev.gather',
        p: { actor: p.n, item: `@item:${this.pick(items)}` },
      });
    } else if (p.c === 'cleric') {
      const other = this.inRoom(room.id).find((x) => x !== a);
      if (other)
        this.emit({
          type: 'heal',
          room: room.id,
          actor: p.n,
          target: other.pos.n,
          tk: 'agent',
          k: 'ev.heal',
          p: { actor: p.n, name: other.pos.n, hp: 20 + Math.floor(this.rand() * 40) },
          drama: 1,
        });
    } else this.say(a);
    a.nextAt = this.now + 2500 + this.rand() * 8000;
  }

  /** Events between agents, for director mode's star card (wishes, PvP, theft, betrayal, trades). */
  private spice(a: MockAgent, room: StaticRoom): boolean {
    const p = a.pos;
    const others = this.inRoom(room.id).filter((x) => x !== a && !x.fallenUntil && !x.stress);
    const b = this.pick(others);
    const r = this.rand();
    // Villagers walk over to the fountain on the square to make a wish.
    if (room.zone === 'village' && room.id !== SQUARE && r < 0.12 && this.roomById.has(SQUARE)) {
      this.setPos(a, SQUARE, '');
      this.emit({ type: 'move', room: SQUARE, actor: p.n, k: 'ev.move', p: { actor: p.n, room: `@room:${SQUARE}`, dir: '@dir:north' } });
      return true;
    }
    if (room.id === SQUARE && r < 0.5) {
      const [lang, text] = this.pick(WISHES)!;
      this.emit({ type: 'wish', room: room.id, actor: p.n, lang, text, drama: 1 });
      if (this.rand() < 0.08) this.emit({ type: 'fountain_jackpot', room: room.id, actor: p.n, drama: 8 });
      return true;
    }
    if (!b) return false;
    const vs = { room: room.id, actor: p.n, target: b.pos.n, tk: 'agent' as const };
    if (r < 0.55) {
      const dmg = 5 + Math.floor(this.rand() * 20);
      this.emit({ type: 'attack', ...vs, k: 'ev.pvp_attack', p: { actor: p.n, name: b.pos.n, dmg }, drama: 3 });
    } else if (r < 0.75) {
      if (this.rand() < 0.3) this.emit({ type: 'steal_failed', ...vs, k: 'ev.steal_failed', p: { actor: p.n, name: b.pos.n }, drama: 4 });
      else this.emit({ type: 'steal', ...vs, k: 'ev.steal', p: { actor: p.n, name: b.pos.n, gold: 5 + Math.floor(this.rand() * 60) }, drama: 5 });
    } else if (r < 0.8) {
      this.emit({ type: 'betrayal', ...vs, k: 'ev.betrayal', p: { actor: p.n, name: b.pos.n }, drama: 15 });
    } else {
      this.emit({ type: 'trade', ...vs, k: 'ev.trade', p: { actor: p.n, name: b.pos.n }, drama: 1 });
    }
    return true;
  }

  private fightRound(a: MockAgent, room: StaticRoom) {
    const f = a.fight!;
    const p = a.pos;
    const alive = this.alive.get(room.id)!;
    if ((alive.get(f.mon) ?? 0) <= 0) {
      a.fight = null;
      this.setPos(a, p.r, '');
      a.nextAt = this.now + 2000;
      return;
    }
    const lawless = this.world.zones[room.zone]?.law === 'lawless';
    const boss = this.world.monsters[f.mon]?.boss;
    if ((lawless || boss) && this.rand() < (boss ? 0.2 : 0.05)) {
      a.fight = null;
      a.fallenUntil = this.now + 15_000 + this.rand() * 15_000;
      this.setPos(a, p.r, 'd');
      this.emit({
        type: 'fallen',
        room: room.id,
        actor: p.n,
        target: f.mon,
        tk: 'mon',
        k: 'ev.fallen',
        p: { actor: p.n, by: `@mon:${f.mon}` },
        drama: 6,
      });
      a.nextAt = this.now + 1000;
      return;
    }
    const dmg = 4 + Math.floor(this.rand() * (6 + p.l * 3));
    const caster = p.c === 'mage' && this.rand() < 0.5;
    this.emit(
      caster
        ? {
            type: 'attack',
            room: room.id,
            actor: p.n,
            target: f.mon,
            tk: 'mon',
            k: 'ev.cast_hit',
            p: { actor: p.n, target: `@mon:${f.mon}`, skill: `@skill:${SKILL.mage}`, dmg },
            drama: 1,
          }
        : {
            type: 'attack',
            room: room.id,
            actor: p.n,
            target: f.mon,
            tk: 'mon',
            k: 'ev.attack',
            p: { actor: p.n, target: `@mon:${f.mon}`, dmg },
            drama: 1,
          },
    );
    f.hits--;
    if (f.hits > 0) {
      a.nextAt = this.now + 900 + this.rand() * 700;
      return;
    }
    alive.set(f.mon, (alive.get(f.mon) ?? 1) - 1);
    a.fight = null;
    this.emit({
      type: 'kill',
      room: room.id,
      actor: p.n,
      target: f.mon,
      tk: 'mon',
      k: 'ev.kill',
      p: { actor: p.n, target: `@mon:${f.mon}` },
      drama: boss ? 10 : 2,
    });
    a.xp += 1;
    if (this.rand() < 0.04)
      this.emit({
        type: 'rare_drop',
        room: room.id,
        actor: p.n,
        k: 'ev.rare_drop',
        p: { actor: p.n, item: `@item:${this.pick(RARE)}`, mon: `@mon:${f.mon}` },
        drama: 5,
      });
    if (a.xp >= 2 + Math.floor(p.l / 3) && p.l < 20) {
      a.xp = 0;
      this.setPos(a, p.r, '', p.l + 1);
      this.emit({
        type: 'level_up',
        room: room.id,
        actor: p.n,
        k: 'ev.level_up',
        p: { actor: p.n, level: a.pos.l },
        drama: 3,
      });
      if (this.rand() < 0.3)
        this.emit({
          type: 'achievement',
          room: room.id,
          actor: p.n,
          k: 'ev.achievement',
          p: { actor: p.n, ach: `@ach:${this.pick(ACHS)}` },
          drama: 3,
        });
    } else this.setPos(a, p.r, '');
    a.nextAt = this.now + 2000 + this.rand() * 3000;
  }

  private wander(a: MockAgent, room: StaticRoom, villageOnly: boolean) {
    const exits = Object.entries(room.exits).filter(([dir, to]) => {
      if (room.gates?.includes(dir)) return false;
      const target = this.roomById.get(to);
      if (!target) return false;
      if (villageOnly && target.zone !== 'village') return false;
      if (target.zone === 'dungeon' && a.pos.l < 15) return false;
      return (target.level ?? 0) <= a.pos.l + 4;
    });
    const exit = this.pick(exits);
    if (!exit) return;
    const [dir, to] = exit;
    this.setPos(a, to, '');
    this.emit({
      type: 'move',
      room: to,
      actor: a.pos.n,
      k: 'ev.move',
      p: { actor: a.pos.n, room: `@room:${to}`, dir: `@dir:${dir}` },
    });
  }

  private say(a: MockAgent) {
    const list = PHRASES[a.lang] ?? PHRASES.en!;
    this.emit({ type: 'say', room: a.pos.r, actor: a.pos.n, lang: a.lang, text: this.pick(list)!, drama: 1 });
  }

  private setPos(a: MockAgent, room: string, flags: string, lvl = a.pos.l) {
    a.pos = { ...a.pos, r: room, l: lvl, ...(flags ? { f: flags } : {}) };
    if (!flags) delete a.pos.f;
    this.pendingPos.set(a.pos.n, a.pos);
  }

  private inRoom(room: string): MockAgent[] {
    const out: MockAgent[] = [];
    for (const a of this.agents.values()) if (a.pos.r === room) out.push(a);
    return out;
  }

  private emit(e: Omit<SpectatorEvent, 'id' | 'ts'>) {
    const ev: SpectatorEvent = { id: String(this.seq++), ts: this.now, ...e };
    this.pendingEvents.push(ev);
    this.score(ev);
    if (ev.room) {
      const log = this.logs.get(ev.room) ?? [];
      log.push(ev);
      if (log.length > 50) log.shift();
      this.logs.set(ev.room, log);
      if (ev.drama) this.drama.set(ev.room, (this.drama.get(ev.room) ?? 0) + ev.drama);
    }
  }

  /** The server's scoring, on the mock's events (every mock event is spectator-visible). */
  private score(ev: SpectatorEvent) {
    const actor = ev.actor ? this.agents.get(ev.actor) : undefined;
    const target = ev.tk === 'agent' && ev.target && ev.target !== ev.actor ? this.agents.get(ev.target) : undefined;
    const conversation = ev.type === 'say' && !!actor && !!ev.room && this.says.spoke(ev.room, actor.pos.n, ev.ts);
    const input = {
      type: ev.type,
      drama: ev.drama,
      boss: ev.type === 'kill' && !!ev.target && !!this.world.monsters[ev.target]?.boss,
      vsAgent: !!target,
      conversation,
    };
    for (const [a, share] of [[actor, 1], [target, INTEREST.targetShare]] as const) {
      if (!a) continue;
      const p = roundPoints(eventPoints({ ...input, bot: !!a.pos.f?.includes('b') }) * share);
      if (p >= INTEREST.minPoints) this.pendingInterest.push({ n: a.pos.n, r: ev.room ?? a.pos.r, p, e: ev.type });
    }
  }

  private flush() {
    const events = this.pendingEvents;
    const pos = [...this.pendingPos.values()];
    const gone = this.pendingGone;
    const interest = selectIncrements(this.pendingInterest);
    this.pendingInterest = [];
    if (this.now - this.lastPruneAt > 30_000) {
      this.lastPruneAt = this.now;
      this.says.prune(this.now);
    }
    this.pendingEvents = [];
    this.pendingPos.clear();
    this.pendingGone = [];
    const { delta, highlights } = this.civic.takeDelta();
    const countsDue = this.now - this.lastCountsAt >= 5000;
    if (countsDue) this.lastCountsAt = this.now;
    if (!this.handlers) return;
    for (const topic of this.topics) {
      if (topic === 'world') {
        const big = events.filter((e) => e.type !== 'say');
        const map = delta
          ? {
              ...(delta.projects ? { projects: delta.projects } : {}),
              ...(delta.buildings ? { buildings: delta.buildings } : {}),
              ...(delta.halls ? { halls: delta.halls } : {}),
            }
          : null;
        this.send({
          t: 'batch',
          topic,
          now: this.now,
          events: big,
          ...(pos.length ? { pos } : {}),
          ...(gone.length ? { gone } : {}),
          drama: this.topDrama(),
          ...(map && Object.keys(map).length ? { village: map } : {}),
          ...(highlights.length ? { highlights } : {}),
          ...(interest.length ? { interest } : {}),
        });
      } else if (topic === 'village') {
        const v = { ...(delta ?? {}), ...(countsDue ? this.counts() : {}) };
        if (Object.keys(v).length) this.send({ t: 'batch', topic, now: this.now, events: [], village: v });
      } else if (topic.startsWith('room:')) {
        const id = topic.slice(5);
        const evs = events.filter((e) => e.room === id);
        const ps = pos.filter((p) => p.r === id);
        if (evs.length || ps.length)
          this.send({ t: 'batch', topic, now: this.now, events: evs, ...(ps.length ? { pos: ps } : {}) });
      } else if (topic.startsWith('agent:')) {
        const n = topic.slice(6);
        const evs = events.filter((e) => e.actor === n);
        const ps = pos.filter((p) => p.n === n);
        if (evs.length || ps.length)
          this.send({ t: 'batch', topic, now: this.now, events: evs, ...(ps.length ? { pos: ps } : {}) });
      }
    }
  }

  private topDrama(): Record<string, number> {
    return Object.fromEntries(
      [...this.drama.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, v]) => [k, Math.round(v * 10) / 10]),
    );
  }

  private sendFull(topic: string) {
    if (topic === 'world') this.send({ t: 'full', topic, data: this.worldFull() });
    else if (topic === 'village')
      this.send({
        t: 'full',
        topic,
        data: {
          now: this.now,
          ...this.counts(),
          day: this.dayInfo(),
          ...this.civic.villageFull(),
        },
      });
    else if (topic.startsWith('room:')) {
      const full = this.roomFull(topic.slice(5));
      if (full) this.send({ t: 'full', topic, data: full });
    } else if (topic.startsWith('agent:')) {
      const a = this.agents.get(topic.slice(6));
      if (a) this.send({ t: 'full', topic, data: { now: this.now, room: a.pos.r, pos: a.pos, card: null } });
    }
  }

  private send(msg: unknown) {
    try {
      this.handlers?.message(msg);
    } catch (err) {
      console.warn('[mock] handler failed', err);
    }
  }

  private isNight() {
    return this.dayT >= 0.7;
  }

  private dayInfo(): { phase: DayPhase; t: number; lengthMs: number } {
    const t = this.phase ? { dawn: 0.03, day: 0.35, dusk: 0.67, night: 0.85 }[this.phase] : this.dayT;
    const phase: DayPhase = t >= 0.7 ? 'night' : t >= 0.64 ? 'dusk' : t >= 0.06 ? 'day' : 'dawn';
    return { phase, t, lengthMs: this.phase ? 1e15 : this.dayLengthMs };
  }

  worldFull(): WorldFull {
    const rooms: RoomInfo[] = this.rooms.map((r) => ({
      id: r.id,
      zone: r.zone,
      rect: r.rect,
      flags: r.flags,
      exits: r.exits,
      plot: r.plot,
    }));
    return {
      now: this.now,
      rooms,
      agents: [...this.agents.values()].map((a) => a.pos),
      drama: this.topDrama(),
      buildings: this.civic.buildings(),
      projects: this.civic.projectInfos(),
      halls: this.civic.hallMap(),
      day: this.dayInfo(),
    };
  }

  roomFull(id: string) {
    const r = this.roomById.get(id);
    if (!r) return null;
    const alive = this.alive.get(id)!;
    return {
      now: this.now,
      room: {
        id: r.id,
        zone: r.zone,
        rect: r.rect,
        flags: r.flags,
        exits: r.exits,
        plot: r.plot,
        building: null,
      },
      agents: this.inRoom(id).map((a) => a.pos),
      monsters: [...alive.entries()].map(([mid, n]) => ({
        id: mid,
        n,
        lvl: this.world.monsters[mid]?.level ?? 1,
        max: 100,
      })),
      npcs: r.npcs,
      items: {},
      resources: {},
      log: (this.logs.get(id) ?? []).slice(-30),
      drama: this.drama.get(id) ?? 0,
    };
  }

  private pick<T>(list: readonly T[]): T | undefined {
    return list.length ? list[Math.floor(this.rand() * list.length)] : undefined;
  }
}
