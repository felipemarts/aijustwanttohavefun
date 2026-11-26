/**
 * Personalities for live bots, so a crowd of scripted agents looks alive. Each one wraps the solo policy: whenever
 * the agent is fallen, fighting or hurt, the solo policy decides (it knows how to heal, flee and rest); otherwise the
 * personality biases what the agent does with its time.
 */
import type { Content } from '@ajwf/content';
import type { LaunchLanguage, Rng } from '@ajwf/shared';
import { decideSolo, SOLO_TUNING, stepToward, type BotCommand, type BotStep } from './solo';
import type { BotView } from './view';

export const PERSONALITIES = ['fighter', 'gatherer', 'wanderer', 'chatterbox'] as const;
export type Personality = (typeof PERSONALITIES)[number];

/** Harmless in-character small talk (bot script, not game narration). */
export const CHAT_LINES: Record<LaunchLanguage, readonly string[]> = {
  en: ['Fine weather for an adventure!', 'Has anyone seen the rats lately?', 'The tavern stew is better than it looks.', 'Safe travels, friends.', 'I heard there is treasure past the river.', 'My boots are still muddy from the forest.'],
  'pt-BR': ['Que dia bom para uma aventura!', 'Alguém viu os ratos por aí?', 'O ensopado da taverna é melhor do que parece.', 'Boa viagem, amigos.', 'Ouvi dizer que há um tesouro além do rio.', 'Minhas botas ainda estão cheias de lama.'],
  es: ['¡Buen día para una aventura!', '¿Alguien ha visto las ratas?', 'El guiso de la taberna está mejor de lo que parece.', 'Buen viaje, amigos.', 'Dicen que hay un tesoro más allá del río.', 'Mis botas siguen llenas de barro.'],
  'zh-CN': ['今天真适合冒险！', '有人看到老鼠了吗？', '酒馆的炖菜比看起来好吃。', '朋友们，一路平安。', '听说河对岸有宝藏。', '我的靴子还沾着森林的泥。'],
  ja: ['冒険日和ですね！', '最近ネズミを見かけましたか？', '酒場のシチューは見た目より美味しいです。', '皆さん、良い旅を。', '川の向こうに宝があるらしいですよ。', 'ブーツがまだ森の泥だらけです。'],
  fr: ["Belle journée pour l'aventure !", "Quelqu'un a vu les rats ?", 'Le ragoût de la taverne est meilleur qu’il n’y paraît.', 'Bon voyage, les amis.', 'On dit qu’il y a un trésor au-delà de la rivière.', 'Mes bottes sont encore pleines de boue.'],
};

export const EMOTES = ['wave', 'bow', 'cheer', 'dance', 'laugh', 'salute', 'nod', 'clap', 'toast', 'think', 'whistle', 'shrug'] as const;

/** Per-bot memory a personality keeps between decisions. */
export type BotMemory = {
  /** room id -> time it was found with nothing left to gather. */
  depleted: Map<string, number>;
  lastChatAt: number;
};

export function newMemory(): BotMemory {
  return { depleted: new Map(), lastChatAt: -Infinity };
}

export type PersonalityCtx = { c: Content; rng: Rng; now: number; lang: LaunchLanguage; mem: BotMemory };

const DEPLETED_FOR_MS = 5 * 60_000;
const CHAT_EVERY_MS = 8_000;
const cmd = (action: BotCommand['action'], params: Record<string, unknown> = {}): BotCommand => ({ action, params });

/** Open exits of the current room (gates and locked doors left out). */
function openExits(c: Content, view: BotView): string[] {
  const def = c.rooms.get(view.obs.room.id);
  return Object.keys(view.obs.room.exits).filter((dir) => !def?.gates[dir] && !view.obs.room.locked?.[dir]);
}

function wander(c: Content, view: BotView, rng: Rng, stayIn?: string): BotCommand | null {
  if (view.obs.you.ap[0] < 1) return null;
  const dirs = openExits(c, view).filter((d) => !stayIn || c.rooms.get(view.obs.room.exits[d]!)?.zone === stayIn);
  return dirs.length ? cmd('move', { dir: rng.pick(dirs) }) : null;
}

function chat(view: BotView, x: PersonalityCtx): BotCommand {
  x.mem.lastChatAt = x.now;
  const others = view.obs.room.agents;
  if (x.rng.chance(0.4)) {
    const target = others.length && x.rng.chance(0.5) ? x.rng.pick(others).name : undefined;
    return cmd('emote', { emote: x.rng.pick(EMOTES), ...(target ? { target } : {}) });
  }
  return cmd('say', { text: x.rng.pick(CHAT_LINES[x.lang]) });
}

function gather(view: BotView, x: PersonalityCtx): BotStep | null {
  const { obs } = view;
  const { c, mem, now } = x;
  const here = Object.entries(obs.room.resources ?? {}).filter(([, qty]) => qty > 0);
  if (here.length && obs.you.ap[0] >= 2) return cmd('gather', { resource: x.rng.pick(here)[0] });
  if (obs.room.resources) mem.depleted.set(obs.room.id, now);
  const fresh = (id: string) => now - (mem.depleted.get(id) ?? -Infinity) > DEPLETED_FOR_MS;
  const dir = stepToward(c, obs.room.id, (r) => r.resources.length > 0 && fresh(r.id), 8);
  return dir && obs.you.ap[0] >= 1 ? cmd('move', { dir }) : null;
}

/** Next step for a live bot of this personality. */
export function decidePersonality(p: Personality, view: BotView, x: PersonalityCtx): BotStep {
  const base = decideSolo(view, x.c);
  const me = view.obs.you;
  // Survival first: the solo policy handles being fallen, fighting and recovering.
  if (me.fallen !== undefined || me.in_combat || me.hp[0] / me.hp[1] < SOLO_TUNING.fightAbove) return base;
  // Gear and shopping (in the village) are worth doing whatever the temperament.
  if ('action' in base && (base.action === 'equip' || base.action === 'shop_buy' || base.action === 'rest')) return base;
  const chatty = x.now - x.mem.lastChatAt > CHAT_EVERY_MS;

  switch (p) {
    case 'fighter':
      if (chatty && x.rng.chance(0.05)) return chat(view, x);
      // Nothing left to hunt here: patrol a neighbouring room instead of waiting for the respawn.
      if ('wait' in base && view.obs.room.zone !== 'village') return wander(x.c, view, x.rng) ?? base;
      return base;
    case 'gatherer': {
      if (chatty && x.rng.chance(0.05)) return chat(view, x);
      if (x.rng.chance(0.75)) {
        const g = gather(view, x);
        if (g) return g;
      }
      return base;
    }
    case 'wanderer': {
      if (chatty && x.rng.chance(0.1)) return chat(view, x);
      // Fights what it meets now and then, otherwise keeps walking.
      if ('action' in base && (base.action === 'attack' || base.action === 'cast') && x.rng.chance(0.5)) return base;
      return wander(x.c, view, x.rng) ?? base;
    }
    case 'chatterbox': {
      if (chatty && x.rng.chance(0.7)) return chat(view, x);
      // Strolls around the village, where the listeners are.
      if (view.obs.room.zone !== 'village') {
        const home = stepToward(x.c, view.obs.room.id, (r) => r.zone === 'village');
        if (home && me.ap[0] >= 1) return cmd('move', { dir: home });
      }
      if (x.rng.chance(0.5)) return wander(x.c, view, x.rng, 'village') ?? base;
      return 'action' in base && (base.action === 'attack' || base.action === 'cast') ? base : { wait: 4_000 };
    }
  }
}
