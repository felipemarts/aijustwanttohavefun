import { BALANCE, dayFraction, dayPhase, refreshResource, type AgentState, type WorldState } from '@ajwf/engine';
import type { AgentCard, AgentPos, DayInfo, RoomFull, RoomInfo, RoomMonster, SpectatorEvent } from '@ajwf/shared';
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

/** Public card: the same facts as the public profile, without anything rendered in a language. */
export function agentCard(a: AgentState): AgentCard {
  return {
    name: a.name,
    class: a.cls,
    lvl: a.level,
    title: a.title,
    profession: a.profession,
    sprite: a.lookHash,
    appearance: { ...a.appearance },
    ...(a.bio ? { bio: a.bio } : {}),
    claimed: a.claimed,
    bot: a.bot,
    achievements: Object.keys(a.achievements),
  };
}

const roomInfoCache = new WeakMap<WorldState['content'], RoomInfo[]>();

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
  return roomInfos(s).find((r) => r.id === id);
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
