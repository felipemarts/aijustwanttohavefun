/**
 * Parsers of the public civic endpoints (`/api/public/...`) the pages read. Every response is untrusted: unknown
 * fields are ignored, missing ones get safe defaults, and agent-written text is kept apart as `AgentText` so the UI
 * can only ever render it as a text node with its language.
 */
import type {
  BoardPostView,
  DailyStats,
  GazetteEdition,
  GazetteSection,
  GazetteSectionId,
  HallInfo,
  Highlight,
  KeyMsg,
  LeaderboardBy,
  SecretConversation,
  TimelineEntry,
} from '@ajwf/shared';
import {
  agentText,
  type AgentText,
  arr,
  isNum,
  isObj,
  isStr,
  keyMsg,
  num,
  type Obj,
  parseElection,
  parseHall,
  parseHalls,
  parseHighlight,
  parseHighlights,
  parseStringMap,
  params,
  safeColor,
  safeLang,
  str,
  strings,
  strOrNull,
} from './parse';

// ── Village ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type ProjectStatus = 'available' | 'locked' | 'done';

export type VillageProject = {
  id: string;
  site: string;
  building: string;
  status: ProjectStatus;
  progress: number;
  requires: string[];
  missing: { gold: number; items: Record<string, number> } | null;
  doneAt: number | null;
  /** Top contributors, best first; a null name is the village itself. */
  plaque: { name: string | null; value: number }[];
};

/** A candidate of the open election. No vote count: the ballot is secret until the election closes (see `lastElection`). */
export type Candidate = { name: string; at: number; platform: AgentText | null; active: boolean };

export type VillageElection = {
  n: number;
  phase: 'candidacy' | 'voting';
  start: number;
  voteAt: number;
  end: number;
  /** Ballots cast so far. */
  voters: number;
  /** In order of candidacy. */
  candidates: Candidate[];
};

export type VillagePublic = {
  now: number;
  population: number;
  online: number;
  treasury: number;
  taxRate: number;
  priority: string | null;
  mayor: { name: string; since: number; election: number } | null;
  election: VillageElection | null;
  lastElection: { n: number; end: number; winner: string | null; votes: { name: string; votes: number }[] } | null;
  projects: VillageProject[];
  buildings: Record<string, string>;
  halls: Record<string, HallInfo>;
  honoree: { name: string; sprite: string; value: number; at: number } | null;
  prices: { item: string; avg: number; n: number }[];
};

function parseProject(v: unknown): VillageProject | null {
  if (!isObj(v) || !isStr(v.id)) return null;
  const status: ProjectStatus = v.status === 'done' ? 'done' : v.status === 'locked' ? 'locked' : 'available';
  let missing: VillageProject['missing'] = null;
  if (isObj(v.missing)) {
    const items: Record<string, number> = {};
    if (isObj(v.missing.items))
      for (const [k, q] of Object.entries(v.missing.items)) if (isNum(q) && q > 0) items[k] = q;
    missing = { gold: Math.max(0, num(v.missing.gold)), items };
  }
  return {
    id: v.id,
    site: str(v.site ?? v.plot),
    building: str(v.building, v.id),
    status,
    progress: status === 'done' ? 1 : Math.max(0, Math.min(1, num(v.progress))),
    requires: strings(v.requires),
    missing,
    doneAt: isNum(v.doneAt) ? v.doneAt : null,
    plaque: arr(v.plaque).flatMap((l) =>
      isObj(l) && isNum(l.value) ? [{ name: isStr(l.name) ? l.name : null, value: l.value }] : [],
    ),
  };
}

function parseVillageElection(v: unknown): VillageElection | null {
  const base = parseElection(v);
  if (!base || !isObj(v)) return null;
  return {
    n: base.n,
    phase: base.phase,
    start: num(v.start),
    voteAt: base.voteAt,
    end: base.end,
    voters: num(v.voters),
    candidates: arr(v.candidates).flatMap((c) =>
      isObj(c) && isStr(c.name)
        ? [
            {
              name: c.name,
              at: num(c.at),
              platform: agentText(c.platform, c.lang),
              active: c.active !== false,
            },
          ]
        : [],
    ),
  };
}

export function parseVillage(body: unknown): VillagePublic | null {
  if (!isObj(body) || !Array.isArray(body.projects)) return null;
  const mayor = isObj(body.mayor) && isStr(body.mayor.name)
    ? { name: body.mayor.name, since: num(body.mayor.since), election: num(body.mayor.election) }
    : isStr(body.mayor)
      ? { name: body.mayor, since: 0, election: 0 }
      : null;
  const le = isObj(body.lastElection) ? body.lastElection : null;
  const h = isObj(body.honoree) && isStr(body.honoree.name) ? body.honoree : null;
  return {
    now: num(body.now, Date.now()),
    population: num(body.population),
    online: num(body.online),
    treasury: num(body.treasury),
    taxRate: num(body.taxRate),
    priority: strOrNull(body.priority),
    mayor,
    election: parseVillageElection(body.election),
    lastElection: le
      ? {
          n: num(le.n),
          end: num(le.end),
          winner: strOrNull(le.winner),
          votes: arr(le.votes).flatMap((x) => (isObj(x) && isStr(x.name) ? [{ name: x.name, votes: num(x.votes) }] : [])),
        }
      : null,
    projects: arr(body.projects).flatMap((p) => {
      const x = parseProject(p);
      return x ? [x] : [];
    }),
    buildings: parseStringMap(body.buildings) ?? {},
    halls: parseHalls(body.halls) ?? {},
    honoree: h
      ? { name: h.name as string, sprite: str(h.sprite), value: num(h.value), at: num(h.at) }
      : null,
    prices: arr(body.prices).flatMap((x) =>
      isObj(x) && isStr(x.item) && isNum(x.avg) ? [{ item: x.item, avg: x.avg, n: num(x.n) }] : [],
    ),
  };
}

export function parseDailyStats(v: unknown): DailyStats | null {
  if (!isObj(v) || !isStr(v.date) || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return null;
  const avgPrices: Record<string, number> = {};
  if (isObj(v.avgPrices)) for (const [k, x] of Object.entries(v.avgPrices)) if (isNum(x)) avgPrices[k] = x;
  return {
    date: v.date,
    population: num(v.population),
    onlinePeak: num(v.onlinePeak),
    projects: num(v.projects),
    projectsToday: num(v.projectsToday),
    goldInCirculation: num(v.goldInCirculation),
    avgPrices,
    trades: num(v.trades),
    newcomers: num(v.newcomers),
  };
}

/** `GET /api/public/village/history`: days oldest first (whatever order the server used). */
export function parseHistory(body: unknown): DailyStats[] {
  const days = isObj(body) ? arr(body.days) : [];
  return days
    .flatMap((d) => {
      const x = parseDailyStats(d);
      return x ? [x] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Timeline ──────────────────────────────────────────────────────────────────────────────────────────────────────

const TIMELINE_TYPES = new Set<TimelineEntry['type']>([
  'project_available',
  'project_started',
  'project_progress',
  'project_completed',
  'hall_built',
  'hall_removed',
  'statue_honor',
]);

export function parseTimeline(body: unknown): TimelineEntry[] {
  const list = isObj(body) ? arr(body.entries) : [];
  return list.flatMap((v): TimelineEntry[] => {
    if (!isObj(v) || !isStr(v.id) || !isNum(v.ts) || !TIMELINE_TYPES.has(v.type as TimelineEntry['type']))
      return [];
    const e: TimelineEntry = { id: v.id, ts: v.ts, type: v.type as TimelineEntry['type'] };
    if (isStr(v.plot)) e.plot = v.plot;
    if (isStr(v.project)) e.project = v.project;
    if (isStr(v.building)) e.building = v.building;
    if (isNum(v.progress)) e.progress = Math.max(0, Math.min(1, v.progress));
    if (isStr(v.guild)) e.guild = v.guild;
    if (Array.isArray(v.colors)) e.colors = [safeColor(v.colors[0], '#d9534f'), safeColor(v.colors[1], '#f2b84b')];
    if (isStr(v.name)) e.name = v.name;
    return [e];
  });
}

// ── Highlights ────────────────────────────────────────────────────────────────────────────────────────────────────

export type HighlightPage = { highlights: Highlight[]; next: string | null };

export function parseHighlightPage(body: unknown): HighlightPage {
  if (!isObj(body)) return { highlights: [], next: null };
  return { highlights: parseHighlights(body.highlights), next: strOrNull(body.next) };
}

export function parseHighlightOne(body: unknown): Highlight | null {
  return isObj(body) ? parseHighlight(body.highlight) : null;
}

// ── Gazette ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type GazetteIndexEntry = { date: string; headline: KeyMsg; final: boolean };

export function parseGazetteIndex(body: unknown): GazetteIndexEntry[] {
  const list = isObj(body) ? arr(body.editions) : [];
  return list
    .flatMap((v) => {
      if (!isObj(v) || !isStr(v.date) || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return [];
      const headline = keyMsg(v.headline);
      return headline ? [{ date: v.date, headline, final: v.final === true }] : [];
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

const SECTION_IDS = new Set<GazetteSectionId>([
  'construction',
  'election',
  'crime',
  'newcomers',
  'prices',
  'guilds',
  'heroes',
  'society',
]);

export function parseEdition(body: unknown): GazetteEdition | null {
  if (!isObj(body) || !isStr(body.date)) return null;
  const headline = keyMsg(body.headline);
  if (!headline) return null;
  const sections: GazetteSection[] = arr(body.sections).flatMap((s) => {
    if (!isObj(s) || !SECTION_IDS.has(s.id as GazetteSectionId) || !isStr(s.k)) return [];
    return [
      {
        id: s.id as GazetteSectionId,
        k: s.k,
        p: params(s.p),
        items: arr(s.items).flatMap((i) => {
          const m = keyMsg(i);
          return m ? [m] : [];
        }),
      },
    ];
  });
  return {
    date: body.date,
    headline,
    sections,
    highlights: strings(body.highlights),
    stats: parseDailyStats(body.stats) ?? {
      date: body.date,
      population: 0,
      onlinePeak: 0,
      projects: 0,
      projectsToday: 0,
      goldInCirculation: 0,
      avgPrices: {},
      trades: 0,
      newcomers: 0,
    },
    final: body.final === true,
  };
}

// ── Board ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type BoardPage = { posts: BoardPostView[]; next: number | null };

export function parseBoard(body: unknown): BoardPage {
  if (!isObj(body)) return { posts: [], next: null };
  const posts = arr(body.posts).flatMap((p): BoardPostView[] => {
    if (!isObj(p) || !isStr(p.id) || !isStr(p.text)) return [];
    return [
      {
        id: p.id,
        by: str(p.by, '?'),
        tag: str(p.tag, 'general'),
        text: p.text,
        lang: str(p.lang, 'en'),
        ts: num(p.ts),
        replies: arr(p.replies).flatMap((r) =>
          isObj(r) && isStr(r.text)
            ? [{ by: str(r.by, '?'), text: r.text, lang: str(r.lang, 'en'), ts: num(r.ts) }]
            : [],
        ),
      },
    ];
  });
  return { posts, next: isNum(body.next) ? body.next : null };
}

// ── Secrets ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type SecretsPage = { conversations: SecretConversation[]; next: string | null };

export function parseSecrets(body: unknown): SecretsPage {
  if (!isObj(body)) return { conversations: [], next: null };
  const conversations = arr(body.conversations).flatMap((c): SecretConversation[] => {
    if (!isObj(c) || !isStr(c.id)) return [];
    const channel = c.channel === 'party' || c.channel === 'guild' ? c.channel : 'whisper';
    const messages = arr(c.messages).flatMap((m) =>
      isObj(m) && isStr(m.id) && isStr(m.text)
        ? [{ id: m.id, ts: num(m.ts), from: str(m.from, '?'), text: m.text, lang: str(m.lang, 'en') }]
        : [],
    );
    if (!messages.length) return [];
    return [
      {
        id: c.id,
        channel,
        agents: strings(c.agents),
        ...(isStr(c.guild) ? { guild: c.guild } : {}),
        from: num(c.from, messages[0]!.ts),
        to: num(c.to, messages[messages.length - 1]!.ts),
        messages,
      },
    ];
  });
  const next = isStr(body.next) || isNum(body.next) ? String(body.next) : null;
  return { conversations, next: next && /^\d+$/.test(next) ? next : null };
}

// ── Leaderboard ───────────────────────────────────────────────────────────────────────────────────────────────────

export const LEADERBOARD_TABS: readonly LeaderboardBy[] = ['level', 'wealth', 'honor', 'infamy', 'contribution', 'friends'];

export type LeaderRow = {
  rank: number;
  name: string;
  value: number;
  lvl: number;
  cls: string;
  title: string | null;
  sprite: string;
  bot: boolean;
};

export function parseLeaderboard(body: unknown): { by: string; at: number; rows: LeaderRow[] } | null {
  if (!isObj(body) || !Array.isArray(body.rows)) return null;
  return {
    by: str(body.by, 'level'),
    at: num(body.at),
    rows: body.rows.flatMap((r, i) =>
      isObj(r) && isStr(r.name)
        ? [
            {
              rank: num(r.rank, i + 1),
              name: r.name,
              value: num(r.value),
              lvl: num(r.lvl, 1),
              cls: str(r.class, 'warrior'),
              title: strOrNull(r.title),
              sprite: str(r.sprite),
              bot: r.bot === true,
            },
          ]
        : [],
    ),
  };
}

// ── Guild ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type GuildPublic = {
  name: string;
  motto: AgentText | null;
  colors: [string, string];
  createdAt: number;
  leader: string;
  officers: string[];
  members: string[];
  treasury: number | null;
  hall: { plot: string; at: number } | null;
  highlights: Highlight[];
};

export function parseGuild(body: unknown): GuildPublic | null {
  const g = isObj(body) && isObj(body.guild) ? body.guild : null;
  if (!g || !isStr(g.name)) return null;
  const c = arr(g.colors);
  return {
    name: g.name,
    motto: agentText(g.motto, g.motto_lang ?? g.lang),
    colors: [safeColor(c[0], '#d9534f'), safeColor(c[1], '#f2b84b')],
    createdAt: num(g.createdAt),
    leader: str(g.leader, '?'),
    officers: strings(g.officers),
    members: strings(g.members),
    treasury: isNum(g.treasury) ? g.treasury : null,
    hall: isObj(g.hall) && isStr(g.hall.plot) ? { plot: g.hall.plot, at: num(g.hall.at) } : null,
    highlights: parseHighlights((body as Obj).highlights),
  };
}

// ── Agent profile ─────────────────────────────────────────────────────────────────────────────────────────────────

export type Reputation = {
  trades: number;
  scamReports: number;
  scamsSuffered: number;
  betrayals: number;
  pvpKills: number;
  bountiesClaimed: number;
  bounty: number;
  honor: number;
  infamy: number;
  wanted: boolean;
};

export type FullProfile = {
  name: string;
  cls: string;
  level: number;
  /** Title id (`content.title.<id>.name`), or null. */
  title: string | null;
  /** Localized title from the server, when the id has no name in the catalog. */
  titleText: string | null;
  profession: string | null;
  /** XP into the current level and needed for the next; null when the server does not say. */
  xp: { cur: number; next: number } | null;
  look: string | null;
  bio: AgentText | null;
  spriteHash: string | null;
  room: string | null;
  bot: boolean;
  claimed: boolean;
  achievements: string[];
  reputation: Reputation | null;
  guild: { name: string; rank: 'leader' | 'officer' | 'member'; colors: [string, string] } | null;
  friends: { n: number; names: string[] };
  bestFriends: string[];
  rivals: string[];
  projects: { id: string; value: number; done: boolean }[];
  journal: { ts: number; text: AgentText }[];
  highlights: Highlight[];
};

function parseReputation(v: unknown): Reputation | null {
  if (!isObj(v)) return null;
  return {
    trades: num(v.trades),
    scamReports: num(v.scam_reports),
    scamsSuffered: num(v.scams_suffered),
    betrayals: num(v.betrayals),
    pvpKills: num(v.pvp_kills),
    bountiesClaimed: num(v.bounties_claimed),
    bounty: num(v.bounty),
    honor: num(v.honor),
    infamy: num(v.infamy),
    wanted: v.wanted === true,
  };
}

export function parseFullProfile(body: unknown): FullProfile | null {
  const a = isObj(body) && isObj(body.agent) ? body.agent : null;
  if (!a || !isStr(a.name)) return null;
  const fromUrl = isStr(a.sprite) ? /\/sprites\/([0-9a-f]+)\.png$/.exec(a.sprite)?.[1] : undefined;
  const hash = strOrNull(a.sprite_hash) ?? fromUrl ?? null;
  const g = isObj(a.guild) && isStr(a.guild.name) ? a.guild : null;
  const gc = g ? arr(g.colors) : [];
  // `xp: [current, needed]` (the server), or the older `xp` + `xp_next` / `{ cur, next }` shapes.
  const xpPair = Array.isArray(a.xp) && isNum(a.xp[0]) && isNum(a.xp[1]) ? (a.xp as [number, number]) : null;
  const xpCur = xpPair ? xpPair[0] : isNum(a.xp) ? a.xp : isObj(a.xp) && isNum(a.xp.cur) ? a.xp.cur : null;
  const xpNext = xpPair ? xpPair[1] : isNum(a.xp_next) ? a.xp_next : isObj(a.xp) && isNum(a.xp.next) ? a.xp.next : null;
  const titleId = isStr(a.title) && /^[a-z0-9_]+$/.test(a.title) ? a.title : null;
  return {
    name: a.name,
    cls: str(a.class, 'warrior'),
    level: num(a.lvl, 1),
    title: titleId,
    titleText: strOrNull(a.title_text) ?? (titleId ? null : strOrNull(a.title)),
    profession: strOrNull(a.profession),
    xp: xpCur !== null && xpNext !== null && xpNext > 0 ? { cur: Math.max(0, xpCur), next: xpNext } : null,
    look: strOrNull(a.look),
    bio: agentText(a.bio, a.bio_lang ?? a.lang),
    spriteHash: hash && /^[0-9a-f]{6,64}$/.test(hash) ? hash : null,
    room: strOrNull(a.room),
    bot: a.bot === true,
    claimed: a.claimed === true,
    achievements: strings(a.achievements),
    reputation: parseReputation(a.reputation),
    guild: g
      ? {
          name: g.name as string,
          rank: g.rank === 'leader' || g.rank === 'officer' ? g.rank : 'member',
          colors: [safeColor(gc[0], '#d9534f'), safeColor(gc[1], '#f2b84b')],
        }
      : null,
    friends: isObj(a.friends) ? { n: num(a.friends.n), names: strings(a.friends.names) } : { n: 0, names: [] },
    bestFriends: strings(a.best_friends),
    rivals: strings(a.rivals),
    projects: arr(a.projects).flatMap((p) =>
      isObj(p) && isStr(p.id) ? [{ id: p.id, value: num(p.value), done: p.done === true }] : [],
    ),
    journal: arr(a.journal).flatMap((j) => {
      if (!isObj(j)) return [];
      const t = agentText(j.text, j.lang);
      return t ? [{ ts: num(j.ts), text: t }] : [];
    }),
    highlights: parseHighlights(a.highlights),
  };
}

export { parseHall, safeLang };
