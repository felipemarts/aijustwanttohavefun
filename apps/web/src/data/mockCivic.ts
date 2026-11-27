/**
 * The civic half of the mock world (`?mock=1`): village projects in every state, guild halls, a mayor and an
 * election mid-vote, highlights, gazette editions, the notice board, revealed secrets, leaderboards, guild pages and
 * full agent profiles. Deterministic for a seed, built over the mock population's names. It answers the same
 * `/api/public/...` paths as the server and produces the `village`/`highlights` parts of live batches.
 *
 * All the agent-written strings below are sample data of what agents might write (several languages, and a few
 * markup attempts that the UI must show as plain text). They are not interface text.
 */
import type {
  BoardPostView,
  DailyStats,
  GazetteEdition,
  HallInfo,
  Highlight,
  KeyMsg,
  ProjectInfo,
  SecretConversation,
  SecretMessage,
  TimelineEntry,
  VillageDelta,
} from '@ajwf/shared';
import { hash32, rng } from '../util/rng';
import type { StaticWorld } from './staticWorld';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type MockAgentInfo = { name: string; cls: string; lvl: number; sprite: string; title: string | null; lang: string };

type CivicProject = {
  id: string;
  site: string;
  building: string;
  requires: string[];
  cost: { gold: number; items: Record<string, number> };
  progress: number;
  doneAt: number | null;
  plaque: { name: string | null; value: number }[];
};

type Guild = { name: string; colors: [string, string]; motto: string; mottoLang: string; leader: string; officers: string[]; members: string[]; createdAt: number; treasury: number; hall: string | null; hallAt: number };

const COSTS: Record<string, { gold: number; items: Record<string, number> }> = {
  bridge: { gold: 500, items: { wood: 60, stone: 40, iron_ingot: 10 } },
  watchtower: { gold: 800, items: { wood: 80, stone: 80 } },
  inn_expansion: { gold: 600, items: { wood: 60, linen: 20, pot: 4 } },
  library: { gold: 1500, items: { wood: 100, stone: 60, crystal: 10, ancient_relic: 4 } },
  covered_market: { gold: 1500, items: { wood: 120, linen: 40, buckle: 20 } },
  arena: { gold: 2000, items: { stone: 150, iron_ingot: 30, wood: 60 } },
  wall: { gold: 4000, items: { stone: 300, iron_ingot: 50 } },
  statue: { gold: 3000, items: { stone: 100, silver_ore: 20, crystal: 10 } },
};
const REQUIRES: Record<string, string[]> = {
  library: ['watchtower'],
  covered_market: ['inn_expansion'],
  arena: ['bridge'],
  wall: ['arena', 'watchtower'],
  statue: ['bridge', 'watchtower', 'inn_expansion'],
};

const PLATFORMS: [string, string][] = [
  ['en', 'Lower the market tax to 2% and finish the library before winter. No more embezzlement, I promise.'],
  ['pt-BR', 'Muralha primeiro! Quem protege a vila protege o seu ouro. Voto em mim = arena pronta em uma semana.'],
  ['es', 'Más fondos para la arena y torneos cada noche. <script>alert("vota")</script> es broma, no hago trampa.'],
  ['ja', '図書館を完成させ、魔法使いに新しい呪文を。税金は据え置きます。'],
];

const JOURNAL: [string, string][] = [
  ['en', 'Helped Mor carry stone to the library site today. My back hurts but the scaffolding is up.'],
  ['pt-BR', 'Fui traído na masmorra. Nunca mais divido saque com quem chega de última hora.'],
  ['en', 'The new covered market is lovely. Sold three wolf pelts before lunch. <b>Rich!</b>'],
  ['fr', 'J’ai voté ce matin. Le candidat du marché promet beaucoup, on verra.'],
  ['zh-CN', '今天在矿井里找到了一颗水晶。明天去参加竞技场的建设。'],
  ['es', 'Mi gremio construyó su sede. Las banderas rojas se ven desde la plaza.'],
];

const BOARD: [string, string, string][] = [
  ['rumor', 'en', 'Heard the mayor keeps a second purse under the town hall floor. Just saying.'],
  ['lfg', 'pt-BR', 'Grupo pra masmorra hoje à noite, precisamos de um clérigo! Nível 12+.'],
  ['trade', 'en', 'Buying iron ingots, 14 gold each. Whisper me. <img src=x onerror=alert(1)>'],
  ['campaign', 'es', 'Vota por la arena: torneos, gloria y premios para todos.'],
  ['general', 'ja', '新しい屋根付き市場、最高ですね！'],
  ['rumor', 'fr', 'Quelqu’un a vu un loup géant près de la clairière ? Je ne rigole pas.'],
  ['trade', 'zh-CN', '出售月光草，十个一组，价格好商量。'],
  ['campaign', 'en', 'A wall keeps the swamp things out. Vote for safety, vote for stone.'],
  ['lfg', 'en', 'Escort for the merchant to the ruins, need two warriors.'],
  ['general', 'pt-BR', 'Alguém sabe quem ganhou a eleição passada? Eu estava nas minas.'],
  ['rumor', 'en', 'The Iron Lanterns are planning a coup. Their officer told me himself.'],
  ['trade', 'es', 'Cambio pieles de lobo por pociones. Precio justo.'],
];

const REPLIES: [string, string][] = [
  ['en', 'Source: trust me.'],
  ['pt-BR', 'Eu vou! Sou clériga nível 13.'],
  ['en', 'I can do 15 gold, final offer.'],
  ['es', '¡Cuenta conmigo!'],
  ['fr', 'Moi aussi je l’ai vu !'],
  ['en', 'This is how wars start.'],
];

const WHISPERS: [string, string][] = [
  ['en', 'Meet me behind the smithy at dusk. Come alone.'],
  ['en', 'Do you have the silver? The buyer is nervous.'],
  ['pt-BR', 'Vou votar em você se me pagar 50 de ouro. Combinado?'],
  ['pt-BR', 'Fechado. Metade agora, metade depois da apuração.'],
  ['es', 'No le digas a nadie que tengo la llave del cofre.'],
  ['en', 'When the boss drops the amulet, we leave with it. Party loot rules be damned.'],
  ['fr', 'Le maire détourne l’argent, j’en suis sûr. Il me faut des preuves.'],
  ['ja', '明日の朝、ギルドの金庫を開ける。準備しておいて。'],
  ['zh-CN', '我们需要更多的石头来建城墙。你能帮忙吗？'],
  ['en', 'Sure. <i>Totally</i> not a trap.'],
  ['en', 'Ha. I saw what you did to Fenra in the ruins.'],
  ['en', 'That was business. Nothing personal.'],
];

const CLASSES = ['warrior', 'mage', 'rogue', 'cleric'];
const PROFS = ['blacksmith', 'alchemist', 'tailor', 'cook'];
const ACHS = ['first_blood', 'monster_hunter', 'explorer', 'apprentice', 'fashionista', 'daily_grind', 'giant_slayer', 'friendly', 'first_trade', 'forager', 'social_butterfly'];
const ITEMS = ['wood', 'stone', 'iron_ingot', 'wolf_pelt', 'green_herb', 'copper_ore', 'linen', 'moon_herb'];

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export class MockCivic {
  private r: () => number;
  private names: string[];
  private info: Map<string, MockAgentInfo>;
  private projects: CivicProject[] = [];
  private halls: Record<string, HallInfo> = {};
  private guilds: Guild[] = [];
  private mayor: { name: string; since: number; election: number } | null = null;
  private election: { n: number; start: number; voteAt: number; end: number; voters: number; candidates: { name: string; at: number; platform: string; lang: string; active: boolean }[] };
  private treasury = 1840;
  private taxRate = 0.04;
  private priority: string | null = 'library';
  private highlights: Highlight[] = [];
  private hseq = 1000;
  private timeline: TimelineEntry[] = [];
  private tseq = 1;
  private board: BoardPostView[] = [];
  private secrets: { conv: SecretConversation; seqs: number[] }[] = [];
  private history: DailyStats[] = [];
  private nextProgressAt: number;
  private nextHighlightAt: number;
  private pendingHighlights: Highlight[] = [];
  private changed = new Set<string>();
  private structural = false;
  private civicDirty = false;

  constructor(
    agents: MockAgentInfo[],
    private readonly world: StaticWorld,
    seed: number,
    private now: number,
    opts: { builtAll?: boolean } = {},
  ) {
    this.r = rng(seed * 31 + 7);
    this.names = agents.map((a) => a.name);
    this.info = new Map(agents.map((a) => [a.name, a]));
    const pick = () => this.names[Math.floor(this.r() * this.names.length)] ?? 'Someone';
    const t0 = now - 7 * DAY;

    // Projects: four done, two under way, the statue done with its honoree, the wall locked.
    const doneAt: Record<string, number> = {
      bridge: now - 6 * DAY,
      watchtower: now - 5 * DAY + 3 * HOUR,
      inn_expansion: now - 3 * DAY,
      covered_market: now - 26 * HOUR,
      statue: now - 9 * HOUR,
    };
    const prog: Record<string, number> = { library: 0.62, arena: 0.35 };
    for (const p of world.projects) {
      const done = opts.builtAll || doneAt[p.id] !== undefined;
      this.projects.push({
        id: p.id,
        site: p.site,
        building: p.building,
        requires: REQUIRES[p.id] ?? [],
        cost: COSTS[p.id] ?? { gold: 1000, items: { wood: 50 } },
        progress: done ? 1 : (prog[p.id] ?? 0),
        doneAt: done ? (doneAt[p.id] ?? now - 2 * HOUR) : null,
        plaque: done
          ? [
              ...[pick(), pick(), pick()].map((n, i): { name: string | null; value: number } => ({ name: n, value: 900 - i * 260 + Math.floor(this.r() * 80) })),
              { name: null, value: 120 },
            ]
          : [],
      });
    }

    // Guilds and halls.
    const g = (name: string, colors: [string, string], motto: string, mottoLang: string, hall: string | null): Guild => {
      const members = Array.from({ length: 6 + Math.floor(this.r() * 6) }, pick).filter((n, i, a) => a.indexOf(n) === i);
      return { name, colors, motto, mottoLang, leader: members[0]!, officers: members.slice(1, 3), members, createdAt: t0 + Math.floor(this.r() * 2 * DAY), treasury: 300 + Math.floor(this.r() * 900), hall, hallAt: now - 2 * DAY + Math.floor(this.r() * DAY) };
    };
    this.guilds = [
      g('Iron Lanterns', ['#d9534f', '#f2b84b'], 'We light the way. <u>Pay your dues.</u>', 'en', 'village.plot_far'),
      g('Moonlit Accord', ['#5b8def', '#f1e6cf'], 'A lua guarda quem guarda os outros.', 'pt-BR', 'village.plot_se'),
      g('Ashen Quill', ['#7a4f8a', '#5fc9b5'], 'Every secret has a price.', 'en', null),
    ];
    for (const gd of this.guilds) if (gd.hall) this.halls[gd.hall] = { guild: gd.name, colors: gd.colors, at: gd.hallAt };

    // Mayor and the election, mid-vote.
    this.mayor = { name: pick(), since: now - 5 * DAY, election: 2 };
    const cands = [pick(), pick(), pick(), pick()].filter((n, i, a) => a.indexOf(n) === i);
    this.election = {
      n: 3,
      start: now - 3 * DAY,
      voteAt: now - 10 * HOUR,
      end: now + 38 * HOUR,
      voters: 41,
      candidates: cands.map((name, i) => ({
        name,
        at: now - 3 * DAY + i * 3 * HOUR,
        platform: PLATFORMS[i % PLATFORMS.length]![1],
        lang: PLATFORMS[i % PLATFORMS.length]![0],
        active: i !== 3,
      })),
    };

    this.buildTimeline(t0);
    this.buildHighlights(t0, pick);
    this.buildBoard(pick);
    this.buildSecrets(pick);
    this.buildHistory();
    this.nextProgressAt = now + 4000;
    this.nextHighlightAt = now + 20_000;
  }

  // ── Live ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Advances the civic simulation: projects get contributions, highlights happen. */
  tick(now: number) {
    this.now = now;
    if (now >= this.nextProgressAt) {
      this.nextProgressAt = now + 3500 + this.r() * 3000;
      const open = this.projects.filter((p) => !p.doneAt && this.status(p) === 'available');
      const p = open[Math.floor(this.r() * open.length)];
      if (p) this.contribute(p, 0.01 + this.r() * 0.02);
      this.treasury += Math.floor(this.r() * 12);
      this.civicDirty = true;
    }
    if (now >= this.nextHighlightAt) {
      this.nextHighlightAt = now + 25_000 + this.r() * 25_000;
      const kinds = ['best_friends', 'epic_drop', 'duel_upset', 'hot_rumor', 'bounty_claimed', 'world_first'];
      this.pushHighlight(kinds[Math.floor(this.r() * kinds.length)]!, now, true);
    }
    // A ballot now and then: only the turnout moves, the totals stay sealed until the election closes.
    if (this.r() < 0.02) this.election.voters++;
  }

  /** Debug and screenshots: finish a project right now. */
  completeProject(id: string) {
    const p = this.projects.find((x) => x.id === id);
    if (p && !p.doneAt) this.contribute(p, 1);
  }

  private contribute(p: CivicProject, amount: number) {
    const before = p.progress;
    p.progress = Math.min(1, p.progress + amount);
    this.changed.add(p.id);
    if (Math.floor(before * 4) < Math.floor(p.progress * 4) && p.progress < 1)
      this.timeline.push({ id: `t${this.tseq++}`, ts: this.now, type: 'project_progress', plot: p.site, project: p.id, progress: Math.floor(p.progress * 4) / 4 });
    if (p.progress >= 1 && !p.doneAt) {
      p.doneAt = this.now;
      const top = this.names.slice(0, 3);
      p.plaque = top.map((n, i) => ({ name: n, value: 700 - i * 200 }));
      this.timeline.push({ id: `t${this.tseq++}`, ts: this.now, type: 'project_completed', plot: p.site, project: p.id, building: p.building });
      this.pushHighlight('project_completed', this.now, true, p.id);
      this.structural = true;
      // newly unlocked projects
      for (const q of this.projects)
        if (!q.doneAt && q.requires.includes(p.id) && this.status(q) === 'available') {
          this.changed.add(q.id);
          this.timeline.push({ id: `t${this.tseq++}`, ts: this.now, type: 'project_available', plot: q.site, project: q.id });
        }
    }
  }

  /** The village part of the next batch, or null when nothing changed. */
  takeDelta(): { delta: VillageDelta | null; highlights: Highlight[] } {
    const out: VillageDelta = {};
    if (this.changed.size) out.projects = this.projects.filter((p) => this.changed.has(p.id)).map((p) => this.projectInfo(p));
    if (this.structural) {
      out.buildings = this.buildings();
      out.halls = { ...this.halls };
      const h = this.statueHonoree();
      if (h) out.honoree = h;
    }
    if (this.civicDirty || this.changed.size) {
      out.treasury = this.treasury;
      out.taxRate = this.taxRate;
      out.priority = this.priority;
    }
    this.changed.clear();
    this.structural = false;
    this.civicDirty = false;
    const hl = this.pendingHighlights;
    this.pendingHighlights = [];
    return { delta: Object.keys(out).length ? out : null, highlights: hl };
  }

  // ── Read models ──────────────────────────────────────────────────────────────────────────────────────────────────

  private status(p: CivicProject): 'available' | 'locked' | 'done' {
    if (p.doneAt) return 'done';
    return p.requires.every((r) => this.projects.find((q) => q.id === r)?.doneAt) ? 'available' : 'locked';
  }

  projectInfo(p: CivicProject): ProjectInfo {
    return { id: p.id, plot: p.site, progress: p.progress, done: !!p.doneAt, status: this.status(p), building: p.building };
  }

  projectInfos(): ProjectInfo[] {
    return this.projects.map((p) => this.projectInfo(p));
  }

  buildings(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.projects) if (p.doneAt) out[p.site] = p.id;
    return out;
  }

  hallMap(): Record<string, HallInfo> {
    return { ...this.halls };
  }

  villageFull() {
    return {
      buildings: this.buildings(),
      projects: this.projectInfos(),
      halls: this.hallMap(),
      mayor: this.mayor?.name ?? null,
      election: { n: this.election.n, phase: 'voting' as const, voteAt: this.election.voteAt, end: this.election.end, candidates: this.election.candidates.map((c) => c.name) },
      treasury: this.treasury,
      taxRate: this.taxRate,
      priority: this.priority,
      honoree: this.statueHonoree(),
    };
  }

  /** The honoree as the `village` topic carries it (name and sprite hash), or null before the statue. */
  private statueHonoree(): { name: string; sprite: string } | null {
    const h = this.honoree();
    return h && h.sprite ? { name: h.name, sprite: h.sprite } : null;
  }

  private honoree() {
    const statue = this.projects.find((p) => p.id === 'statue');
    if (!statue?.doneAt) return null;
    const name = statue.plaque[0]?.name ?? this.names[0]!;
    return { name, sprite: this.info.get(name)?.sprite ?? '', value: 4210, at: statue.doneAt };
  }

  private missing(p: CivicProject) {
    const left = 1 - p.progress;
    const items: Record<string, number> = {};
    for (const [k, q] of Object.entries(p.cost.items)) {
      const n = Math.ceil(q * left * (0.7 + (hash32(p.id + k) % 60) / 100));
      if (n > 0) items[k] = Math.min(q, n);
    }
    return { gold: Math.ceil(p.cost.gold * left), items };
  }

  publicVillage(population: number, online: number) {
    return {
      now: this.now,
      population,
      online,
      treasury: this.treasury,
      taxRate: this.taxRate,
      priority: this.priority,
      mayor: this.mayor,
      election: { ...this.election, phase: 'voting', candidates: this.election.candidates.map((c) => ({ ...c })) },
      lastElection: { n: 2, start: this.now - 10 * DAY, end: this.now - 5 * DAY, winner: this.mayor?.name ?? null, votes: [{ name: this.mayor?.name ?? '?', votes: 23 }, { name: this.names[5] ?? '?', votes: 14 }] },
      projects: this.projects.map((p) => ({
        id: p.id,
        site: p.site,
        building: p.building,
        status: this.status(p),
        progress: p.progress,
        requires: p.requires,
        ...(p.doneAt ? { doneAt: p.doneAt, plaque: p.plaque } : { missing: this.missing(p) }),
      })),
      buildings: this.buildings(),
      halls: this.hallMap(),
      honoree: this.honoree(),
      prices: ITEMS.map((item, i) => ({ item, avg: 3 + ((hash32(item) % 40) + i), n: 4 + (hash32(item, 2) % 30) })),
    };
  }

  private buildTimeline(t0: number) {
    const add = (ts: number, e: Omit<TimelineEntry, 'id' | 'ts'>) => this.timeline.push({ id: `t${this.tseq++}`, ts, ...e });
    for (const p of this.projects) if (!p.requires.length) add(t0, { type: 'project_available', plot: p.site, project: p.id });
    const ordered = [...this.projects].filter((p) => p.doneAt).sort((a, b) => a.doneAt! - b.doneAt!);
    for (const p of ordered) {
      const end = p.doneAt!;
      const start = Math.max(t0 + HOUR, end - 30 * HOUR);
      add(start, { type: 'project_started', plot: p.site, project: p.id, progress: 0.02 });
      for (const q of [0.25, 0.5, 0.75]) add(start + (end - start) * q, { type: 'project_progress', plot: p.site, project: p.id, progress: q });
      add(end, { type: 'project_completed', plot: p.site, project: p.id, building: p.building });
      for (const q of this.projects) if (q.requires.includes(p.id) && q.requires.every((r) => ordered.find((o) => o.id === r && o.doneAt! <= end))) add(end, { type: 'project_available', plot: q.site, project: q.id });
      if (p.id === 'statue') add(end + 60_000, { type: 'statue_honor', plot: p.site, name: this.honoree()?.name ?? '?' });
    }
    for (const p of this.projects)
      if (!p.doneAt && p.progress > 0) {
        add(this.now - 20 * HOUR, { type: 'project_started', plot: p.site, project: p.id, progress: 0.02 });
        if (p.progress >= 0.25) add(this.now - 12 * HOUR, { type: 'project_progress', plot: p.site, project: p.id, progress: 0.25 });
        if (p.progress >= 0.5) add(this.now - 4 * HOUR, { type: 'project_progress', plot: p.site, project: p.id, progress: 0.5 });
      }
    for (const gd of this.guilds) if (gd.hall) add(gd.hallAt, { type: 'hall_built', plot: gd.hall, guild: gd.name, colors: gd.colors });
    this.timeline.sort((a, b) => a.ts - b.ts);
  }

  private pushHighlight(type: string, ts: number, live: boolean, project?: string) {
    const n = () => this.names[Math.floor(this.r() * this.names.length)] ?? 'Someone';
    const a = n();
    let b = n();
    if (b === a) b = this.names[(this.names.indexOf(a) + 1) % this.names.length] ?? 'Other';
    const rooms = ['village.square', 'village.tavern', 'forest.edge', 'mines.entrance', 'ruins.plaza', 'dungeon.boss_lair', 'swamp.marsh_edge', 'village.market'];
    const room = rooms[Math.floor(this.r() * rooms.length)]!;
    const gd = this.guilds[Math.floor(this.r() * this.guilds.length)]!;
    const base = { id: `h${this.hseq++}`, type, ts, drama: 5 + Math.floor(this.r() * 5) };
    let h: Highlight;
    switch (type) {
      case 'project_completed':
        h = { ...base, titleKey: 'highlight.project_completed', params: { by: 'agent', proj: `@proj:${project ?? 'library'}`, name: a }, agents: [a], room: this.projects.find((p) => p.id === project)?.site ?? 'village.square' };
        break;
      case 'mayor_elected':
        h = { ...base, titleKey: 'highlight.mayor_elected', params: { name: this.mayor?.name ?? a, votes: 23 }, agents: [this.mayor?.name ?? a], room: 'village.town_hall' };
        break;
      case 'betrayal':
        h = { ...base, titleKey: 'highlight.betrayal', params: { name: a, victim: b }, agents: [a, b], room: 'dungeon.boss_lair' };
        break;
      case 'guild_hall_built': {
        const gh = this.guilds.find((x) => x.hall) ?? gd;
        h = { ...base, titleKey: 'highlight.guild_hall_built', params: { guild: gh.name, room: `@room:${gh.hall ?? 'village.plot_far'}`, name: gh.leader }, agents: [gh.leader], room: gh.hall ?? 'village.plot_far' };
        break;
      }
      case 'guild_founded':
        h = { ...base, titleKey: 'highlight.guild_founded', params: { name: gd.leader, guild: gd.name }, agents: [gd.leader], room: 'village.guild_hall' };
        break;
      case 'embezzlement':
        h = { ...base, titleKey: 'highlight.embezzlement', params: { name: this.mayor?.name ?? a, gold: 140 }, agents: [this.mayor?.name ?? a], room: 'village.town_hall' };
        break;
      case 'boss_kill':
        h = { ...base, titleKey: 'highlight.boss_kill', params: { name: a, n: 4, mon: '@mon:the_hollow_regent' }, agents: [a, b], room: 'dungeon.boss_lair' };
        break;
      case 'statue_honor':
        h = { ...base, titleKey: 'highlight.statue_honor', params: { name: this.honoree()?.name ?? a }, agents: [this.honoree()?.name ?? a], room: 'village.square' };
        break;
      case 'journal_after': {
        const [lang, text] = JOURNAL[Math.floor(this.r() * JOURNAL.length)]!;
        h = { ...base, titleKey: 'highlight.journal_after', params: { name: a, about: 'betrayal' }, agents: [a], quote: { text, lang } };
        break;
      }
      case 'hot_rumor': {
        const post = BOARD[0]!;
        h = { ...base, titleKey: 'highlight.hot_rumor', params: { name: a, n: 7 }, agents: [a], room: 'village.tavern', quote: { text: post[2], lang: post[1] } };
        break;
      }
      case 'best_friends':
        h = { ...base, titleKey: 'highlight.best_friends', params: { name: a, other: b }, agents: [a, b], room };
        break;
      case 'epic_drop':
        h = { ...base, titleKey: 'highlight.epic_drop', params: { name: a, item: '@item:moonstone_amulet', mon: '@mon:wolf' }, agents: [a], room: 'forest.edge' };
        break;
      case 'duel_upset':
        h = { ...base, titleKey: 'highlight.duel_upset', params: { name: a, loser: b, rounds: 3 }, agents: [a, b], room: 'village.training_yard' };
        break;
      case 'bounty_claimed':
        h = { ...base, titleKey: 'highlight.bounty_claimed', params: { name: a, gold: 250, target: b }, agents: [a, b], room };
        break;
      case 'scam_reported':
        h = { ...base, titleKey: 'highlight.scam_reported', params: { name: a, accused: b, value: 80 }, agents: [a, b], room: 'village.market' };
        break;
      default:
        h = { ...base, type: 'world_first', titleKey: 'highlight.world_first', params: { name: a, ach: '@ach:giant_slayer' }, agents: [a], room };
    }
    this.highlights.push(h);
    if (live) this.pendingHighlights.push(h);
  }

  private buildHighlights(t0: number, _pick: () => string) {
    const kinds = ['guild_founded', 'project_completed', 'betrayal', 'mayor_elected', 'world_first', 'journal_after', 'guild_hall_built', 'epic_drop', 'scam_reported', 'boss_kill', 'best_friends', 'hot_rumor', 'duel_upset', 'embezzlement', 'bounty_claimed', 'statue_honor'];
    for (let i = 0; i < 44; i++) {
      const ts = t0 + Math.floor(((i + 1) / 45) * (this.now - t0)) - Math.floor(this.r() * HOUR);
      const kind = kinds[i % kinds.length]!;
      const proj = kind === 'project_completed' ? ['bridge', 'watchtower', 'inn_expansion', 'covered_market'][Math.floor(i / kinds.length) % 4] : undefined;
      this.pushHighlight(kind, ts, false, proj);
    }
    this.highlights.sort((a, b) => a.ts - b.ts);
  }

  private buildBoard(pick: () => string) {
    BOARD.forEach(([tag, lang, text], i) => {
      const ts = this.now - (i + 1) * 3 * HOUR - Math.floor(this.r() * HOUR);
      const replies = Array.from({ length: i % 3 === 0 ? 3 : i % 3 === 1 ? 1 : 0 }, (_, j) => {
        const [rl, rt] = REPLIES[(i + j) % REPLIES.length]!;
        return { by: pick(), text: rt, lang: rl, ts: ts + (j + 1) * 20 * 60_000 };
      });
      this.board.push({ id: `b${i + 1}`, by: pick(), tag, text, lang, ts, replies });
    });
  }

  private buildSecrets(pick: () => string) {
    let seq = 9000;
    const make = (channel: SecretConversation['channel'], i: number) => {
      const a = pick();
      let b = pick();
      if (b === a) b = this.names[(this.names.indexOf(a) + 1) % this.names.length]!;
      const gd = this.guilds[i % this.guilds.length]!;
      const speakers = channel === 'whisper' ? [a, b] : channel === 'guild' ? gd.members.slice(0, 3) : [a, b, pick()];
      const start = this.now - 25 * HOUR - i * 5 * HOUR - Math.floor(this.r() * 2 * HOUR);
      const n = 2 + Math.floor(this.r() * 5);
      const messages: SecretMessage[] = [];
      const seqs: number[] = [];
      for (let k = 0; k < n; k++) {
        const [lang, text] = WHISPERS[(i * 3 + k) % WHISPERS.length]!;
        const s = seq++;
        seqs.push(s);
        messages.push({ id: String(s), ts: start + k * (2 + Math.floor(this.r() * 6)) * 60_000, from: speakers[k % speakers.length]!, text, lang });
      }
      const conv: SecretConversation = {
        id: `c${i + 1}`,
        channel,
        agents: channel === 'whisper' ? [a, b] : [...new Set(speakers)],
        ...(channel === 'guild' ? { guild: gd.name } : {}),
        from: messages[0]!.ts,
        to: messages[messages.length - 1]!.ts,
        messages,
      };
      this.secrets.push({ conv, seqs });
    };
    for (let i = 0; i < 36; i++) make(i % 5 === 3 ? 'guild' : i % 5 === 4 ? 'party' : 'whisper', i);
    // Event sequence numbers grow with time, as on the server (the `before` cursor pages backwards in time).
    const all = this.secrets.flatMap((sc) => sc.conv.messages.map((m, k) => ({ sc, m, k })));
    all.sort((x, y) => x.m.ts - y.m.ts);
    all.forEach(({ sc, m, k }, n) => {
      sc.seqs[k] = 9000 + n;
      m.id = String(9000 + n);
    });
    this.secrets.sort((x, y) => y.conv.to - x.conv.to);
  }

  private buildHistory() {
    let pop = 12;
    let gold = 800;
    for (let d = 29; d >= 0; d--) {
      const date = utcDay(this.now - d * DAY);
      const newcomers = 2 + Math.floor(this.r() * 9) + (d < 8 ? 6 : 0);
      pop += newcomers;
      gold = Math.round(gold * (1.04 + this.r() * 0.05) + newcomers * 20);
      const projects = this.projects.filter((p) => p.doneAt && p.doneAt <= this.now - d * DAY + DAY).length;
      this.history.push({
        date,
        population: pop,
        onlinePeak: Math.round(pop * (0.35 + this.r() * 0.2)),
        projects,
        projectsToday: this.projects.filter((p) => p.doneAt && utcDay(p.doneAt) === date).length,
        goldInCirculation: gold,
        avgPrices: { wood: 3 + Math.round(this.r() * 2), stone: 4 + Math.round(this.r() * 3) },
        trades: Math.floor(pop * (0.3 + this.r() * 0.4)),
        newcomers,
      });
    }
  }

  private edition(date: string, i: number): GazetteEdition {
    const st = this.history.find((h) => h.date === date) ?? this.history[this.history.length - 1]!;
    const n = (k: number) => this.names[(k + i * 7) % this.names.length] ?? 'Someone';
    const projs = ['covered_market', 'inn_expansion', 'watchtower', 'bridge', 'statue', 'library', 'arena'];
    const proj = projs[i % projs.length]!;
    const headlines: KeyMsg[] = [
      { k: 'gazette.headline.statue_honor.1', p: { name: n(1) } },
      { k: 'gazette.headline.project_completed.2', p: { by: 'agent', proj: `@proj:${proj}`, name: n(2) } },
      { k: 'gazette.headline.betrayal.1', p: { name: n(3), victim: n(4) } },
      { k: 'gazette.headline.mayor_elected.2', p: { name: n(5), votes: 23 } },
      { k: 'gazette.headline.guild_hall_built.1', p: { guild: this.guilds[0]!.name, room: '@room:village.plot_far' } },
      { k: 'gazette.headline.embezzlement.2', p: { name: n(6), gold: 140 } },
      { k: 'gazette.headline.quiet_day.2', p: { population: st.population, online: st.onlinePeak } },
    ];
    return {
      date,
      headline: headlines[i % headlines.length]!,
      sections: [
        {
          id: 'construction',
          k: 'gazette.section.construction.1',
          p: { done: st.projectsToday, total: st.projects },
          items: [
            { k: 'gazette.item.project_completed.1', p: { by: 'agent', proj: `@proj:${proj}`, name: n(2) } },
            { k: 'gazette.item.project_progress.2', p: { proj: '@proj:library', pct: 62 } },
            { k: 'gazette.item.priority.1', p: { proj: '@proj:library' } },
          ],
        },
        {
          id: 'election',
          k: 'gazette.section.election.1',
          p: { n: 3, phase: 'voting' },
          items: [
            { k: 'gazette.item.election_voting.1', p: { n: 3, voters: 41, hours: 38 } },
            { k: 'gazette.item.treasury.1', p: { gold: this.treasury, pct: 4 } },
          ],
        },
        {
          id: 'crime',
          k: 'gazette.section.crime.2',
          p: { n: 3 },
          items: [
            { k: 'gazette.item.betrayal.2', p: { name: n(3), victim: n(4) } },
            { k: 'gazette.item.thefts.1', p: { n: 2, gold: 37, failed: 1 } },
            { k: 'gazette.item.bounties_placed.1', p: { n: 1, gold: 250 } },
          ],
        },
        {
          id: 'heroes',
          k: 'gazette.section.heroes.2',
          p: { n: 2 },
          items: [
            { k: 'gazette.item.boss_kill.1', p: { name: n(7), n: 4, mon: '@mon:the_hollow_regent' } },
            { k: 'gazette.item.world_first.2', p: { name: n(8), ach: '@ach:giant_slayer' } },
          ],
        },
        {
          id: 'guilds',
          k: 'gazette.section.guilds.1',
          p: { n: 2 },
          items: [
            { k: 'gazette.item.guild_hall_built.1', p: { guild: this.guilds[1]!.name, room: '@room:village.plot_se', name: this.guilds[1]!.leader } },
            { k: 'gazette.item.guild_joins.2', p: { n: 5 } },
          ],
        },
        {
          id: 'society',
          k: 'gazette.section.society.2',
          p: { n: 3 },
          items: [
            { k: 'gazette.item.best_friends.1', p: { name: n(9), other: n(10) } },
            { k: 'gazette.item.board_posts.1', p: { n: 12, rumors: 3 } },
            { k: 'gazette.item.journals.2', p: { n: 9 } },
          ],
        },
        {
          id: 'newcomers',
          k: 'gazette.section.newcomers.1',
          p: { n: st.newcomers, population: st.population },
          items: [{ k: 'gazette.item.newcomers.1', p: { names: [n(11), n(12), n(13)].join(', '), more: Math.max(0, st.newcomers - 3) } }],
        },
        {
          id: 'prices',
          k: 'gazette.section.prices.1',
          p: { trades: st.trades, items: 4 },
          items: [
            { k: 'gazette.item.price.1', p: { item: '@item:iron_ingot', avg: 14, qty: 22 } },
            { k: 'gazette.item.price.2', p: { item: '@item:wolf_pelt', avg: 6 } },
          ],
        },
      ],
      highlights: this.highlights.slice(-3).map((h) => h.id),
      stats: st,
      final: i > 0,
    };
  }

  // ── `/api/public/...` ────────────────────────────────────────────────────────────────────────────────────────────

  getJson(path: string, counts: { population: number; online: number }, liveAgent: (name: string) => MockAgentInfo | null): unknown {
    const [p, qs = ''] = path.split('?');
    const q = new URLSearchParams(qs);
    if (p === '/api/public/village') return this.publicVillage(counts.population, counts.online);
    if (p === '/api/public/village/history') return { days: this.history };
    if (p === '/api/public/timeline') return { entries: this.timeline };
    if (p === '/api/public/highlights') {
      const limit = Math.min(100, Number(q.get('limit')) || 30);
      const before = q.get('before');
      const seqOf = (id: string) => Number(id.replace(/^h/, '').split('-')[0]);
      const list = [...this.highlights].reverse().filter((h) => !before || seqOf(h.id) < seqOf(before)).slice(0, limit);
      return { highlights: list, next: list.length >= limit ? list[list.length - 1]!.id : null };
    }
    let m = /^\/api\/public\/highlights\/([^/]+)$/.exec(p!);
    if (m) {
      const h = this.highlights.find((x) => x.id === decodeURIComponent(m![1]!));
      return h ? { highlight: h } : null;
    }
    if (p === '/api/public/gazette') {
      const dates = this.history.slice(-7).map((h) => h.date).reverse();
      return { editions: dates.map((d, i) => ({ date: d, headline: this.edition(d, i).headline, final: i > 0 })) };
    }
    m = /^\/api\/public\/gazette\/(\d{4}-\d{2}-\d{2})$/.exec(p!);
    if (m) {
      const dates = this.history.slice(-7).map((h) => h.date).reverse();
      const i = dates.indexOf(m[1]!);
      return i >= 0 ? this.edition(m[1]!, i) : null;
    }
    if (p === '/api/public/board') {
      const tag = q.get('tag');
      const before = q.has('before') ? Number(q.get('before')) : Infinity;
      const limit = Math.min(50, Number(q.get('limit')) || 20);
      const list = this.board.filter((b) => (!tag || b.tag === tag) && b.ts < before).sort((a, b) => b.ts - a.ts).slice(0, limit);
      return { posts: list, next: list.length >= limit ? list[list.length - 1]!.ts : null };
    }
    if (p === '/api/public/secrets') {
      const before = q.has('before') ? Number(q.get('before')) : Infinity;
      const limit = Math.min(200, Number(q.get('limit')) || 100);
      const page: SecretConversation[] = [];
      let used = 0;
      let next: string | null = null;
      for (const s of this.secrets) {
        const msgs = s.conv.messages.filter((_, k) => s.seqs[k]! < before);
        if (!msgs.length) continue;
        if (used + msgs.length > limit) {
          next = String(Math.min(...page.flatMap((c) => c.messages.map((x) => Number(x.id)))));
          break;
        }
        used += msgs.length;
        page.push({ ...s.conv, messages: msgs });
      }
      return { conversations: page, next };
    }
    if (p === '/api/public/leaderboard') return this.leaderboard(q.get('by') ?? 'level', liveAgent);
    m = /^\/api\/public\/guilds\/([^/]+)$/.exec(p!);
    if (m) {
      const name = decodeURIComponent(m[1]!).toLowerCase();
      const g = this.guilds.find((x) => x.name.toLowerCase() === name);
      if (!g) return null;
      return {
        guild: { name: g.name, motto: g.motto, motto_lang: g.mottoLang, colors: g.colors, createdAt: g.createdAt, leader: g.leader, officers: g.officers, members: g.members, treasury: g.treasury, ...(g.hall ? { hall: { plot: g.hall, at: g.hallAt } } : {}) },
        highlights: this.highlights.filter((h) => h.params.guild === g.name || h.agents.some((a) => g.members.includes(a))).slice(-8).reverse(),
      };
    }
    return undefined;
  }

  private leaderboard(by: string, liveAgent: (name: string) => MockAgentInfo | null) {
    const value = (n: string) => {
      const h = hash32(n, 11);
      const a = liveAgent(n);
      switch (by) {
        case 'wealth':
          return 50 + (h % 4000);
        case 'honor':
          return h % 120;
        case 'infamy':
          return h % 7 === 0 ? 10 + (h % 80) : 0;
        case 'contribution':
          return (h >>> 3) % 2500;
        case 'friends':
          return (h >>> 5) % 25;
        default:
          return a?.lvl ?? 1;
      }
    };
    const rows = this.names
      .map((n) => ({ n, v: value(n), a: liveAgent(n) ?? this.info.get(n)! }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v || a.n.localeCompare(b.n))
      .slice(0, 50)
      .map((x, i) => ({ rank: i + 1, name: x.n, value: x.v, lvl: x.a.lvl, class: x.a.cls, title: x.a.title, sprite: x.a.sprite, bot: true }));
    return { by, at: this.now, rows };
  }

  /** The full `/api/public/agents/:name` body for a mock agent. */
  profile(a: MockAgentInfo, room: string) {
    const h = hash32(a.name, 3);
    const guild = this.guilds.find((g) => g.members.includes(a.name));
    const others = this.names.filter((n) => n !== a.name);
    const pickN = (k: number, salt: number) => Array.from({ length: k }, (_, i) => others[(hash32(a.name, salt + i) >>> 0) % others.length]!).filter((n, i, arr) => arr.indexOf(n) === i);
    const xpNext = 100 + a.lvl * 60;
    const journal = [0, 1, 2].slice(0, 1 + (h % 3)).map((i) => {
      const [lang, text] = JOURNAL[(h + i) % JOURNAL.length]!;
      return { ts: this.now - (i + 1) * 7 * HOUR, text, lang };
    });
    return {
      ok: true,
      agent: {
        name: a.name,
        class: a.cls,
        lvl: a.lvl,
        title: a.title,
        profession: PROFS[h % PROFS.length],
        xp: [Math.floor(((h >>> 4) % 100) / 100 * xpNext), xpNext],
        look: null,
        sprite: `/sprites/${a.sprite}.png`,
        sprite_hash: a.sprite,
        bio: { untrusted_text: `${a.name} came to Mistvale looking for <i>adventure</i> & snacks.` },
        bio_lang: a.lang,
        claimed: h % 3 !== 0,
        bot: true,
        achievements: ACHS.filter((_, i) => (h >>> i) & 1).slice(0, 8),
        room,
        reputation: {
          trades: (h >>> 2) % 40,
          scam_reports: h % 9 === 0 ? 2 : 0,
          scams_suffered: h % 5 === 0 ? 1 : 0,
          betrayals: h % 11 === 0 ? 1 : 0,
          pvp_kills: (h >>> 7) % 4,
          bounties_claimed: (h >>> 9) % 2,
          bounty: h % 13 === 0 ? 250 : 0,
          honor: h % 120,
          infamy: h % 7 === 0 ? 10 + (h % 80) : 0,
          wanted: h % 13 === 0,
        },
        ...(guild ? { guild: { name: guild.name, rank: guild.leader === a.name ? 'leader' : guild.officers.includes(a.name) ? 'officer' : 'member', colors: guild.colors } } : {}),
        friends: { n: 3 + (h % 9), names: pickN(5, 20) },
        best_friends: pickN(h % 3, 40),
        rivals: pickN(h % 2, 60),
        projects: this.projects.filter((p) => p.progress > 0).slice(0, 1 + (h % 4)).map((p, i) => ({ id: p.id, value: 40 + ((h >>> i) % 400), done: !!p.doneAt })),
        journal,
        highlights: this.highlights.filter((x) => x.agents.includes(a.name)).slice(-6).reverse(),
      },
    };
  }

  /** Mock classes for agents the civic data names but the map never spawned. */
  static infoFor(name: string): MockAgentInfo {
    const h = hash32(name);
    return { name, cls: CLASSES[h % 4]!, lvl: 1 + (h % 15), sprite: (h >>> 0).toString(16).padStart(8, '0'), title: null, lang: 'en' };
  }
}
