/**
 * The playkit's shapes to and from JSON values: how the vectors' inputs are read (with Go's `encoding/json` rules:
 * absent means zero) and how memory is stored (Go's marshal rules: empty `world` maps and `told` are left out).
 */
import { arr, get, isObj, isTrue, members, num, obj, parse, text, write, type JObj, type JV } from './jv.ts';
import { emptyWorld, type Character, type ChatInput, type ChatLine, type GameErr, type Last, type Memory, type Recent, type TurnInput, type World } from './types.ts';

export function characterFrom(v: JV | undefined): Character {
  return {
    name: text(get(v, 'name')),
    class: text(get(v, 'class')),
    language: text(get(v, 'language')),
    persona: text(get(v, 'persona')),
    wish: text(get(v, 'wish')),
    allowPvp: isTrue(get(v, 'allowPvp')),
  };
}

function gameErrFrom(v: JV | undefined): GameErr | undefined {
  if (!isObj(v)) return undefined;
  const hint = text(get(v, 'hint'));
  return { code: text(get(v, 'code')), message: text(get(v, 'message')), ...(hint ? { hint } : {}) };
}

export function lastFrom(v: JV | undefined): Last | null {
  if (!isObj(v)) return null;
  const data = get(v, 'data');
  const error = gameErrFrom(get(v, 'error'));
  return {
    action: text(get(v, 'action')),
    params: get(v, 'params') ?? null,
    ok: isTrue(get(v, 'ok')),
    narration: text(get(v, 'narration')),
    ...(data !== undefined && data !== null ? { data } : {}),
    ...(error ? { error } : {}),
  };
}

export function recentFrom(v: JV | undefined): Recent {
  return { action: text(get(v, 'action')), params: get(v, 'params') ?? null, ok: isTrue(get(v, 'ok')), text: text(get(v, 'text')) };
}

export function chatLinesFrom(v: JV | undefined): ChatLine[] {
  return arr(v).map((c) => ({ from: text(get(c, 'from')), kind: text(get(c, 'kind')), text: text(get(c, 'text')) }));
}

export function worldFrom(v: JV | undefined): World {
  const w = emptyWorld();
  for (const [id, exits] of members(get(v, 'rooms'))) w.rooms.set(id, arr(exits).map((e) => [text(arr(e)[0]), text(arr(e)[1])] as [string, string]));
  for (const [k, x] of members(get(v, 'npcs'))) w.npcs.set(k, text(x));
  for (const [k, x] of members(get(v, 'monsters'))) w.monsters.set(k, text(x));
  return w;
}

export function memoryFrom(v: JV | undefined): Memory {
  return {
    notes: arr(get(v, 'notes')).map((n) => text(n)),
    recent: arr(get(v, 'recent')).map(recentFrom),
    chat: chatLinesFrom(get(v, 'chat')),
    noteWait: Math.trunc(num(get(v, 'noteWait'))),
    world: worldFrom(get(v, 'world')),
    told: arr(get(v, 'told')).map((t) => ({ quest: text(get(t, 'quest')), text: text(get(t, 'text')) })),
  };
}

export function worldTo(w: World): JObj {
  const out = obj();
  if (w.rooms.size) out.set('rooms', new Map([...w.rooms.entries()].map(([id, exits]) => [id, exits.map(([d, r]) => [d, r])])));
  if (w.npcs.size) out.set('npcs', new Map([...w.npcs.entries()]));
  if (w.monsters.size) out.set('monsters', new Map([...w.monsters.entries()]));
  return out;
}

const recentTo = (r: Recent): JObj => obj(['action', r.action], ['params', r.params], ['ok', r.ok], ['text', r.text]);

export function memoryTo(m: Memory): JObj {
  const out = obj(
    ['notes', [...m.notes]],
    ['recent', m.recent.map(recentTo)],
    ['chat', m.chat.map((c) => obj(['from', c.from], ['kind', c.kind], ['text', c.text]))],
    ['noteWait', m.noteWait],
    ['world', worldTo(m.world)],
  );
  if (m.told.length) out.set('told', m.told.map((t) => obj(['quest', t.quest], ['text', t.text])));
  return out;
}

export const memoryToText = (m: Memory): string => write(memoryTo(m));
export const memoryFromText = (s: string | undefined): Memory => memoryFrom(s ? parse(s) : null);

export function turnInputFrom(v: JV): TurnInput {
  return {
    character: characterFrom(get(v, 'character')),
    observation: get(v, 'observation') ?? null,
    me: get(v, 'me') ?? null,
    last: lastFrom(get(v, 'last')),
    events: arr(get(v, 'events')).map((e) => text(e)),
    memory: memoryFrom(get(v, 'memory')),
    command: text(get(v, 'command')),
  };
}

export function chatInputFrom(v: JV): ChatInput {
  return {
    character: characterFrom(get(v, 'character')),
    observation: get(v, 'observation') ?? null,
    me: get(v, 'me') ?? null,
    memory: memoryFrom(get(v, 'memory')),
    history: arr(get(v, 'history')).map((h) => ({ from: text(get(h, 'from')) === 'character' ? ('character' as const) : ('owner' as const), text: text(get(h, 'text')) })),
    text: text(get(v, 'text')),
  };
}

