import { BALANCE, dayFraction, dayPhase, refreshResource, villageView, xpToNext, type AgentState, type WorldState } from '@ajwf/engine';
import type { AgentCard, AgentPos, DayInfo, ElectionInfo, HallInfo, ProjectInfo, RoomFull, RoomInfo, RoomMonster, SpectatorEvent, StatueHonoree } from '@ajwf/shared';
import { SPECTATE } from './constants';

export function dayInfo(now: number): DayInfo {
  return { phase: dayPhase(now), t: Math.round(dayFraction(now) * 1000) / 1000 };
}

/** Map position and badges of an agent. */
export function agentPos(a: AgentState, now: number): AgentPos {
  let f = '';
  if (a.bot) f += 'b';
  if (a.fallen) f += 'd';
  else if (a.combat && a.combat.until > now) f += 'f';
  const p: AgentPos = { n: a.name, r: a.room, l: a.level, c: a.cls, s: a.lookHash, t: a.title };
  if (f) p.f = f;
  return p;
}

/** Everything in an AgentPos that a spectator can see change, as one comparable string. */
export function posKey(p: AgentPos): string {
  return `${p.r}|${p.l}|${p.s}|${p.t ?? ''}|${p.f ?? ''}`;
}

/** XP into the current level and needed for the next (the engine's curve), as `/look` shows it to the agent. */
export function agentXp(a: AgentState): [number, number] {
  return [a.xp, xpToNext(a.level)];
}

/** Public card: the same facts as the public profile, without anything rendered in a language. */
export function agentCard(a: AgentState): AgentCard {
  return {
    name: a.name,
    class: a.cls,
    lvl: a.level,
    title: a.title,
    profession: a.profession,
    xp: agentXp(a),
    sprite: a.lookHash,
    appearance: { ...a.appearance },
    ...(a.bio ? { bio: a.bio, bio_lang: a.lang } : {}),
    claimed: a.claimed,
    bot: a.bot,
    achievements: Object.keys(a.achievements),
  };
}

const roomInfoCache = new WeakMap<WorldState['content'], RoomInfo[]>();

/** The village as the map shows it: projects, buildings, guild halls, mayor and election. O(projects + plots). */
export type VillageMap = {
  projects: ProjectInfo[];
  buildings: Record<string, string>;
  halls: Record<string, HallInfo>;
  mayor: string | null;
  election: ElectionInfo;
  treasury: number;
  taxRate: number;
  priority: string | null;
  honoree: StatueHonoree | null;
};

export function villageMap(s: WorldState, now: number): VillageMap {
  const v = villageView(s, now);
  const buildings: Record<string, string> = {};
  const halls: Record<string, HallInfo> = {};
  for (const [plot, b] of Object.entries(v.buildings)) {
    if (b.kind === 'project') buildings[plot] = b.project;
    else halls[plot] = { guild: b.name, colors: b.colors, at: b.at };
  }
  const e = v.election;
  return {
    projects: v.projects.map((p) => ({ id: p.id, plot: p.site, progress: p.progress, done: p.status === 'done', status: p.status, building: p.building })),
    buildings,
    halls,
    mayor: v.mayor?.name ?? null,
    election: { n: e.n, phase: e.phase, voteAt: e.voteAt, end: e.end, candidates: e.candidates.map((c) => c.name) },
    treasury: v.treasury,
    taxRate: v.taxRate,
    priority: v.priority,
    honoree: v.honoree ? { name: v.honoree.name, sprite: v.honoree.sprite } : null,
  };
}

/** Static map data of every room (cached per content). */
export function roomInfos(s: WorldState): RoomInfo[] {
  let list = roomInfoCache.get(s.content);
  if (!list) {
    list = [...s.content.rooms.values()].map((r) => {
      const info: RoomInfo = { id: r.id, zone: r.zone, rect: r.rect, flags: r.flags, exits: r.exits };
      if (r.flags.includes('plot')) {
        info.plot = true;
        info.building = null;
      }
      return info;
    });
    roomInfoCache.set(s.content, list);
  }
  return list;
}

export function roomInfo(s: WorldState, id: string): RoomInfo | undefined {
  const r = roomInfos(s).find((x) => x.id === id);
  return r?.plot ? { ...r, building: buildingAt(s, id) } : r;
}

/** What stands on a plot: the finished project's building id, `guild_hall`, or null. */
export function buildingAt(s: WorldState, plot: string): string | null {
  if (s.village.halls[plot]) return 'guild_hall';
  for (const p of s.content.projects.values()) if (p.site === plot && s.village.projects[p.id]?.doneAt !== undefined) return p.building;
  return null;
}

/** Room infos with the live building of every plot. */
export function liveRoomInfos(s: WorldState): RoomInfo[] {
  return roomInfos(s).map((r) => (r.plot ? { ...r, building: buildingAt(s, r.id) } : r));
}

/** Monsters by kind, with the HP of wounded ones. Read-only: a monster nobody hit for a while counts as healed. */
function roomMonsters(s: WorldState, roomId: string, now: number): RoomMonster[] {
  const out = new Map<string, RoomMonster>();
  for (const m of s.rooms.get(roomId)?.monsters ?? []) {
    const kind = s.content.monsters.get(m.kind);
    if (!kind) continue;
    let row = out.get(m.kind);
    if (!row) out.set(m.kind, (row = { id: m.kind, n: 0, lvl: kind.level, max: kind.hp }));
    row.n++;
    const reset = m.lastHit > 0 && now - m.lastHit > BALANCE.combat.monsterResetMs;
    if (!reset && m.hp < kind.hp) (row.hurt ??= []).push(m.hp);
  }
  return [...out.values()];
}

export type RoomFullInput = {
  s: WorldState;
  roomId: string;
  now: number;
  log: SpectatorEvent[];
  drama: number;
  isVisible: (agentId: string) => boolean;
};

export function roomFull(o: RoomFullInput): RoomFull | null {
  const { s, roomId, now } = o;
  const room = roomInfo(s, roomId);
  const st = s.rooms.get(roomId);
  const def = s.content.rooms.get(roomId);
  if (!room || !st || !def) return null;
  const agents: AgentPos[] = [];
  let others = 0;
  for (const id of s.roomAgents.get(roomId) ?? []) {
    const a = s.agents.get(id);
    if (!a || a.status !== 'active' || !o.isVisible(id)) continue;
    if (agents.length < SPECTATE.roomAgentsMax) agents.push(agentPos(a, now));
    else others++;
  }
  const resources: Record<string, number> = {};
  for (const r of def.resources) resources[r.id] = refreshResource(s, roomId, r.id, now)?.qty ?? 0;
  const full: RoomFull = {
    now,
    room,
    agents,
    monsters: roomMonsters(s, roomId, now),
    npcs: (s.content.npcsByRoom.get(roomId) ?? []).map((n) => n.id),
    items: { ...st.ground },
    resources,
    log: o.log,
    drama: Math.round(o.drama * 10) / 10,
  };
  if (others) full.others = others;
  return full;
}
