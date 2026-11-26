import type { z } from 'zod';
import { contentSchemas } from './schema';
import type {
  Achievement,
  ClassDef,
  Emote,
  Item,
  Monster,
  Npc,
  Profession,
  Project,
  Puzzle,
  Quest,
  Recipe,
  Room,
  Shop,
  Skill,
  Title,
  Zone,
} from './schema';

export * from './schema';

export type ContentFiles = { [K in keyof typeof contentSchemas]: z.input<(typeof contentSchemas)[K]> };
export type ParsedFiles = { [K in keyof typeof contentSchemas]: z.output<(typeof contentSchemas)[K]> };

/** Indexed, validated static content. Immutable at runtime. */
export type Content = {
  zones: Map<string, Zone>;
  rooms: Map<string, Room>;
  monsters: Map<string, Monster>;
  items: Map<string, Item>;
  recipes: Map<string, Recipe>;
  professions: Map<string, Profession>;
  npcs: Map<string, Npc>;
  shops: Map<string, Shop>;
  quests: Map<string, Quest>;
  achievements: Map<string, Achievement>;
  titles: Map<string, Title>;
  classes: Map<string, ClassDef>;
  skills: Map<string, Skill>;
  emotes: Map<string, Emote>;
  projects: Map<string, Project>;
  puzzles: Map<string, Puzzle>;
  gazetteTemplates: Record<string, number>;
  /** npc ids by room */
  npcsByRoom: Map<string, Npc[]>;
  /** puzzles by room */
  puzzlesByRoom: Map<string, Puzzle[]>;
  /** quests by giver npc */
  questsByGiver: Map<string, Quest[]>;
  /** achievements by stat counter */
  achievementsByStat: Map<string, Achievement[]>;
  /** cosmetic item by layer+option */
  cosmeticItem: Map<string, Item>;
};

export class ContentError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid content:\n  - ${problems.join('\n  - ')}`);
  }
}

function indexBy<T extends { id: string }>(list: T[], kind: string, problems: string[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of list) {
    if (m.has(x.id)) problems.push(`duplicate ${kind} id "${x.id}"`);
    m.set(x.id, x);
  }
  return m;
}

/** Parses raw files (from YAML), validates schemas and every cross reference. Throws ContentError. */
export function buildContent(raw: Partial<ContentFiles>): Content {
  const problems: string[] = [];
  const parsed = {} as ParsedFiles;
  for (const key of Object.keys(contentSchemas) as (keyof typeof contentSchemas)[]) {
    const schema = contentSchemas[key];
    const res = schema.safeParse(raw[key] ?? (key === 'gazette_templates' ? {} : []));
    if (!res.success) {
      for (const issue of res.error.issues.slice(0, 20)) {
        problems.push(`${key}: ${issue.path.join('.')}: ${issue.message}`);
      }
      continue;
    }
    (parsed as Record<string, unknown>)[key] = res.data;
  }
  if (problems.length) throw new ContentError(problems);

  const c: Content = {
    zones: indexBy(parsed.zones, 'zone', problems),
    rooms: indexBy(parsed.rooms, 'room', problems),
    monsters: indexBy(parsed.monsters, 'monster', problems),
    items: indexBy(parsed.items, 'item', problems),
    recipes: indexBy(parsed.recipes, 'recipe', problems),
    professions: indexBy(parsed.professions, 'profession', problems),
    npcs: indexBy(parsed.npcs, 'npc', problems),
    shops: indexBy(parsed.shops, 'shop', problems),
    quests: indexBy(parsed.quests, 'quest', problems),
    achievements: indexBy(parsed.achievements, 'achievement', problems),
    titles: indexBy(parsed.titles, 'title', problems),
    classes: indexBy(parsed.classes, 'class', problems),
    skills: indexBy(parsed.skills, 'skill', problems),
    emotes: indexBy(parsed.emotes, 'emote', problems),
    projects: indexBy(parsed.projects, 'project', problems),
    puzzles: indexBy(parsed.puzzles, 'puzzle', problems),
    gazetteTemplates: parsed.gazette_templates,
    npcsByRoom: new Map(),
    puzzlesByRoom: new Map(),
    questsByGiver: new Map(),
    achievementsByStat: new Map(),
    cosmeticItem: new Map(),
  };

  const need = (map: Map<string, unknown>, ref: string | undefined, where: string, kind: string) => {
    if (ref !== undefined && !map.has(ref)) problems.push(`${where}: unknown ${kind} "${ref}"`);
  };

  for (const r of c.rooms.values()) {
    need(c.zones, r.zone, `room ${r.id}`, 'zone');
    for (const [dir, to] of Object.entries(r.exits)) need(c.rooms, to, `room ${r.id} exit ${dir}`, 'room');
    for (const m of r.monsters) need(c.monsters, m.id, `room ${r.id}`, 'monster');
    for (const res of r.resources) need(c.items, res.id, `room ${r.id} resource`, 'item');
    for (const [dir, g] of Object.entries(r.gates)) {
      if (!(dir in r.exits)) problems.push(`room ${r.id}: gate on missing exit "${dir}"`);
      if (g.requires === 'project') need(c.projects, g.id, `room ${r.id} gate`, 'project');
      if (g.requires === 'puzzle') need(c.puzzles, g.id, `room ${r.id} gate`, 'puzzle');
      if (g.requires === 'boss') need(c.monsters, g.id, `room ${r.id} gate`, 'monster');
    }
  }
  for (const m of c.monsters.values()) for (const d of m.drops) need(c.items, d.item, `monster ${m.id} drop`, 'item');
  for (const it of c.items.values()) {
    if (it.cosmetic) c.cosmeticItem.set(`${it.cosmetic.layer}:${it.cosmetic.option}`, it);
  }
  for (const r of c.recipes.values()) {
    for (const s of r.inputs) need(c.items, s.item, `recipe ${r.id}`, 'item');
    need(c.items, r.output.item, `recipe ${r.id} output`, 'item');
  }
  for (const n of c.npcs.values()) {
    need(c.rooms, n.room, `npc ${n.id}`, 'room');
    need(c.shops, n.shop, `npc ${n.id}`, 'shop');
    if (n.roles.includes('shop') && !n.shop) problems.push(`npc ${n.id}: role shop without shop`);
    const list = c.npcsByRoom.get(n.room) ?? [];
    list.push(n);
    c.npcsByRoom.set(n.room, list);
  }
  for (const s of c.shops.values()) for (const e of s.sells) need(c.items, e.item, `shop ${s.id}`, 'item');
  for (const q of c.quests.values()) {
    need(c.npcs, q.giver, `quest ${q.id}`, 'npc');
    need(c.quests, q.requires, `quest ${q.id} requires`, 'quest');
    for (const s of q.consume) need(c.items, s.item, `quest ${q.id} consume`, 'item');
    for (const s of q.rewards.items) need(c.items, s.item, `quest ${q.id} reward`, 'item');
    for (const st of q.steps) {
      const where = `quest ${q.id} step ${st.type}`;
      if (st.type === 'kill' || st.type === 'boss') need(c.monsters, st.target, where, 'monster');
      if (st.type === 'collect' || st.type === 'deliver' || st.type === 'gather' || st.type === 'equip' || st.type === 'shop_buy')
        need(c.items, st.target, where, 'item');
      if (st.type === 'visit') need(c.rooms, st.target, where, 'room');
      if (st.type === 'talk') need(c.npcs, st.target, where, 'npc');
      if (st.type === 'craft') need(c.recipes, st.target, where, 'recipe');
      if (st.type === 'contribute') need(c.projects, st.target, where, 'project');
      if (st.type === 'puzzle') need(c.puzzles, st.target, where, 'puzzle');
    }
    if (q.escort) {
      need(c.npcs, q.escort.npc, `quest ${q.id} escort`, 'npc');
      need(c.rooms, q.escort.to, `quest ${q.id} escort`, 'room');
    }
    const list = c.questsByGiver.get(q.giver) ?? [];
    list.push(q);
    c.questsByGiver.set(q.giver, list);
  }
  for (const a of c.achievements.values()) {
    need(c.titles, a.title, `achievement ${a.id}`, 'title');
    const list = c.achievementsByStat.get(a.stat) ?? [];
    list.push(a);
    c.achievementsByStat.set(a.stat, list);
  }
  for (const cl of c.classes.values()) {
    for (const s of cl.skills) {
      need(c.skills, s, `class ${cl.id}`, 'skill');
      const sk = c.skills.get(s);
      if (sk && sk.class !== cl.id) problems.push(`class ${cl.id}: skill ${s} belongs to ${sk.class}`);
    }
    for (const s of cl.starter) need(c.items, s.item, `class ${cl.id} starter`, 'item');
  }
  for (const p of c.projects.values()) {
    need(c.rooms, p.site, `project ${p.id}`, 'room');
    for (const r of p.requires) need(c.projects, r, `project ${p.id} requires`, 'project');
    for (const s of p.cost.items) need(c.items, s.item, `project ${p.id} cost`, 'item');
  }
  for (const pz of c.puzzles.values()) {
    need(c.rooms, pz.room, `puzzle ${pz.id}`, 'room');
    for (const s of pz.loot) need(c.items, s.item, `puzzle ${pz.id} loot`, 'item');
    const list = c.puzzlesByRoom.get(pz.room) ?? [];
    list.push(pz);
    c.puzzlesByRoom.set(pz.room, list);
  }
  // Every room must be reachable from the village square.
  const start = 'village.square';
  if (c.rooms.has(start)) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = c.rooms.get(queue.pop()!)!;
      for (const to of Object.values(cur.exits)) if (!seen.has(to) && c.rooms.has(to)) {
          seen.add(to);
          queue.push(to);
        }
    }
    for (const r of c.rooms.keys()) if (!seen.has(r)) problems.push(`room ${r} is unreachable from ${start}`);
  } else problems.push(`missing start room ${start}`);

  if (problems.length) throw new ContentError(problems);
  return c;
}

/** i18n keys every content entity must have in English. */
export function requiredContentKeys(c: Content): string[] {
  const keys: string[] = [];
  const named = (kind: string, ids: Iterable<string>, desc = false) => {
    for (const i of ids) {
      keys.push(`content.${kind}.${i}.name`);
      if (desc) keys.push(`content.${kind}.${i}.desc`);
    }
  };
  named('zone', c.zones.keys());
  named('room', c.rooms.keys(), true);
  named('mon', c.monsters.keys());
  named('item', c.items.keys());
  named('recipe', c.recipes.keys());
  named('prof', c.professions.keys());
  named('npc', c.npcs.keys(), true);
  named('quest', c.quests.keys(), true);
  named('ach', c.achievements.keys(), true);
  named('title', c.titles.keys());
  named('class', c.classes.keys());
  named('skill', c.skills.keys(), true);
  named('emote', c.emotes.keys());
  named('proj', c.projects.keys(), true);
  named('puzzle', c.puzzles.keys(), true);
  return keys;
}
