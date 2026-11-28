/**
 * The few lines the core writes itself (activity, system log entries), in the interface language. English is the
 * fallback; the app may pass more languages through `LocalCoreOptions.texts`.
 */
export type TextKey =
  | 'paused'
  | 'thinking'
  | 'fighting'
  | 'exploring'
  | 'resting_until'
  | 'resting_ap'
  | 'fallen'
  | 'blocked_engine'
  | 'blocked_server'
  | 'blocked_key'
  | 'blocked_rate'
  | 'created'
  | 'started'
  | 'stopped'
  | 'owner_command'
  | 'invalid_decision'
  | 'engine_problem'
  | 'session_end'
  | 'woke_early'
  | 'resumed_act'
  | 'idle'
  | 'session_start'
  | 'why_turns'
  | 'why_ap'
  | 'why_none'
  | 'fallback'
  | 'memory'
  | 'claimed'
  | 'woke'
  | 'pvp_refused'
  | 'level_up';

/** Core lines, plus `stat.<id>` and `slot.<id>` names. */
export type TextTable = Partial<Record<TextKey | `stat.${string}` | `slot.${string}`, string>>;

const EN: Record<TextKey, string> = {
  paused: 'Paused',
  thinking: 'Thinking…',
  fighting: 'Fighting {target}',
  exploring: 'Exploring {room}',
  resting_until: 'Resting until {time}',
  resting_ap: 'Out of action points, resting until {time}',
  fallen: 'Fallen; back on its feet soon',
  blocked_engine: 'The AI engine is not ready',
  blocked_server: 'The game server cannot be reached',
  blocked_key: 'The game refused this character\'s key',
  blocked_rate: 'Waiting for the game\'s rate limit',
  created: '{name} was created and entered the world.',
  started: 'Started playing.',
  stopped: 'Paused by its owner.',
  owner_command: 'You asked: {text}',
  invalid_decision: 'The AI answered with something that is not an allowed action; it will try again.',
  engine_problem: 'The AI engine failed: {reason}',
  session_end: 'Session over ({why}); it will play again later.',
  woke_early: 'Something happened that needs an answer; it woke up early.',
  resumed_act: 'Finished the action it was taking when the app closed.',
  idle: 'Idle',
  session_start: 'A session starts with {ap} AP.',
  why_turns: 'its turns for this session are done',
  why_ap: 'out of action points',
  why_none: 'nothing it could do',
  fallback: 'The AI did not give a valid action twice; it fell back to a safe one.',
  memory: 'It tidied up its notes.',
  claimed: 'Its owner claimed it: it can talk now.',
  woke: 'Woke up early: {kind}.',
  pvp_refused: 'An action against another player was refused (player-versus-player is off).',
  level_up: 'Reached level {level}!',
};

const PT_BR: TextTable = {
  paused: 'Pausado',
  thinking: 'Pensando…',
  fighting: 'Lutando com {target}',
  exploring: 'Explorando {room}',
  resting_until: 'Descansando até {time}',
  resting_ap: 'Sem pontos de ação, descansando até {time}',
  fallen: 'Caído; logo volta a ficar de pé',
  blocked_engine: 'O motor de IA não está pronto',
  blocked_server: 'O servidor do jogo não responde',
  blocked_key: 'O jogo recusou a chave deste personagem',
  blocked_rate: 'Esperando o limite de chamadas do jogo',
  created: '{name} foi criado e entrou no mundo.',
  started: 'Começou a jogar.',
  stopped: 'Pausado pelo dono.',
  owner_command: 'Você pediu: {text}',
  invalid_decision: 'A IA respondeu algo que não é uma ação permitida; vai tentar de novo.',
  engine_problem: 'O motor de IA falhou: {reason}',
  session_end: 'Sessão encerrada ({why}); volta a jogar mais tarde.',
  woke_early: 'Aconteceu algo que pede resposta; acordou mais cedo.',
  resumed_act: 'Concluiu a ação que fazia quando o app fechou.',
  idle: 'Parado',
  session_start: 'Uma sessão começa com {ap} PA.',
  why_turns: 'acabaram os turnos desta sessão',
  why_ap: 'sem pontos de ação',
  why_none: 'nada que pudesse fazer',
  fallback: 'A IA não deu uma ação válida duas vezes; usou uma ação segura.',
  memory: 'Organizou as anotações.',
  claimed: 'O dono o reivindicou: agora pode falar.',
  woke: 'Acordou mais cedo: {kind}.',
  pvp_refused: 'Uma ação contra outro jogador foi recusada (jogador contra jogador está desligado).',
  level_up: 'Chegou ao nível {level}!',
};

const BUILT_IN: Record<string, TextTable> = { en: EN, 'pt-BR': PT_BR, pt: PT_BR };

/** Names of the game's stats (`/me` stats) and equipment slots, per language; unknown ids are prettified. */
const NAMES: Record<string, Record<string, string>> = {
  en: {
    'stat.str': 'Strength', 'stat.int': 'Intellect', 'stat.agi': 'Agility', 'stat.vit': 'Vitality', 'stat.atk': 'Attack', 'stat.def': 'Defence', 'stat.crit': 'Critical chance',
    'slot.weapon': 'Weapon', 'slot.armor': 'Armour', 'slot.trinket': 'Trinket', 'slot.bag': 'Bag',
  },
  pt: {
    'stat.str': 'Força', 'stat.int': 'Intelecto', 'stat.agi': 'Agilidade', 'stat.vit': 'Vitalidade', 'stat.atk': 'Ataque', 'stat.def': 'Defesa', 'stat.crit': 'Chance de crítico',
    'slot.weapon': 'Arma', 'slot.armor': 'Armadura', 'slot.trinket': 'Amuleto', 'slot.bag': 'Bolsa',
  },
};

export class Texts {
  private extra: Record<string, TextTable>;
  constructor(extra: Record<string, TextTable> = {}) {
    this.extra = extra;
  }

  private table(lang: string): TextTable {
    const base = lang.split('-')[0] ?? lang;
    return this.extra[lang] ?? BUILT_IN[lang] ?? this.extra[base] ?? BUILT_IN[base] ?? EN;
  }

  t(lang: string, key: TextKey, p: Record<string, string | number> = {}): string {
    const s = this.table(lang)[key] ?? EN[key];
    return s.replace(/\{(\w+)\}/g, (_, k: string) => (p[k] !== undefined ? String(p[k]) : `{${k}}`));
  }

  private name(lang: string, key: string, id: string): string {
    const base = lang.split('-')[0] ?? lang;
    const k = key as `stat.${string}`;
    const extra = this.extra[lang]?.[k] ?? this.extra[base]?.[k];
    if (typeof extra === 'string') return extra;
    const v = NAMES[lang]?.[key] ?? NAMES[base]?.[key] ?? NAMES.en![key];
    return v ?? (id ? id[0]!.toUpperCase() + id.slice(1).replace(/_/g, ' ') : id);
  }

  stat(lang: string, id: string): string {
    return this.name(lang, `stat.${id}`, id);
  }

  slot(lang: string, id: string): string {
    return this.name(lang, `slot.${id}`, id);
  }

  time(lang: string, ms: number): string {
    try {
      return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    } catch {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }
}
