/**
 * What a bot policy may look at, built either from the in-process engine (`observe` plus the agent's inventory) or
 * from the HTTP API (`GET /look` or `POST /act` plus `GET /me`). Policies only read this, so the same decision code
 * runs in simulations and against a live server.
 */
import type { Content } from '@ajwf/content';
import { observe, type ActionCtx, type WorldState } from '@ajwf/engine';
import type { MeResponse, Room, You } from '@ajwf/sdk';

/** The part of the `inventory` action's answer (or of `GET /me`) a bot uses. */
export type InventoryView = {
  items: Record<string, number>;
  equipped: Record<'weapon' | 'armor' | 'trinket' | 'bag', string | null>;
  skills: { id: string; mp: number; level: number; known: boolean }[];
};

/** The subset of an observation a bot policy reads. The engine's `Observation` satisfies it as is. */
export type ObsView = {
  you: {
    lvl: number;
    hp: [number, number];
    mp: [number, number];
    ap: [number, number];
    gold: number;
    fallen?: number;
    in_combat?: string;
    /** Bag slots used and available. */
    bag?: [number, number];
    title?: string;
    /** Infamy, when any (Wanted above the line: village shops and the inn refuse service). */
    infamy?: number;
    party?: { leader: string; members: string[]; loot: string };
    guild?: string;
  };
  room: {
    id: string;
    zone: string;
    flags: string[];
    exits: Record<string, string>;
    locked?: Record<string, string>;
    agents: { name: string; class?: string; lvl?: number; rel?: string; fallen?: true; wanted?: true }[];
    npcs: { id: string; roles: string[] }[];
    monsters: { id: string; n: number; lvl: number; hp?: [number, number] }[];
    resources?: Record<string, number>;
    /** Dungeon puzzles here: the action that works each, its targets, the class it needs, its live state. */
    puzzles?: { id: string; do: string; targets: string[]; cls?: string; open?: number; pulled?: string[]; held?: string; wait?: number }[];
  };
  /** Requests waiting for an answer (names of agents, guilds, trade offers). */
  pending?: {
    friends?: string[];
    party?: string[];
    guild?: string[];
    trades?: { id: string; from: string; give: { gold?: number; items?: Record<string, number> }; want: { gold?: number; items?: Record<string, number> } }[];
  };
  quest_hint?: { id: string; giver: string; room: string; state: string };
  /** The daily world boss: minutes until it rises, or up now. */
  world_boss?: { id: string; room: string; in?: number; up?: true };
  /** Phase of the game day: dawn, day, dusk or night. */
  time?: string;
  /** Actions that make sense here and now. */
  actions?: string[];
};

export type BotView = { obs: ObsView; inv: InventoryView };

/** From the engine, for simulations: the observation plus what the free `inventory` action would answer. */
export function viewFromWorld(s: WorldState, agentId: string, ctx: ActionCtx): BotView {
  const obs = observe(s, agentId, ctx);
  const a = s.agents.get(agentId)!;
  const cls = s.content.classes.get(a.cls)!;
  return {
    obs,
    inv: {
      items: { ...a.inv },
      equipped: { ...a.equip },
      skills: cls.skills.map((id) => s.content.skills.get(id)!).map((sk) => ({ id: sk.id, mp: sk.mp, level: sk.level, known: a.level >= sk.level })),
    },
  };
}

/** The inventory part of `GET /me`. */
export function inventoryFromMe(me: MeResponse): InventoryView {
  const eq = me.equipment;
  return {
    items: { ...me.inventory },
    equipped: { weapon: eq.weapon ?? null, armor: eq.armor ?? null, trinket: eq.trinket ?? null, bag: eq.bag ?? null },
    skills: me.skills.map((s) => ({ id: s.id, mp: s.mp, level: s.lvl, known: !s.locked })),
  };
}

/**
 * From API answers: the latest `you` and `room` (a compact room leaves out empty lists and the zone, which the
 * static content knows) and the inventory from `GET /me`.
 */
export function viewFromApi(c: Content, you: You, room: Room, inv: InventoryView): BotView {
  return {
    obs: {
      you: {
        lvl: you.lvl,
        hp: you.hp,
        mp: you.mp,
        ap: you.ap,
        gold: you.gold,
        bag: you.bag,
        ...(you.fallen !== undefined ? { fallen: you.fallen } : {}),
        ...(you.in_combat !== undefined ? { in_combat: you.in_combat } : {}),
      },
      room: {
        id: room.id,
        zone: room.zone ?? c.rooms.get(room.id)?.zone ?? '',
        flags: room.flags ?? [],
        exits: room.exits,
        ...(room.locked ? { locked: room.locked } : {}),
        agents: room.agents ?? [],
        npcs: room.npcs ?? [],
        monsters: room.monsters ?? [],
        ...(room.resources ? { resources: room.resources } : {}),
      },
    },
    inv,
  };
}
