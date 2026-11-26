/** Parsing of the public agent profile (`GET /api/public/agents/:name`); every field is untrusted. */

export type AgentProfile = {
  name: string;
  cls: string;
  level: number;
  /** Either a title id (protocol `AgentCard`) or an already localized title (REST profile). */
  title: string | null;
  look: string | null;
  bio: string | null;
  spriteHash: string | null;
  room: string | null;
  achievements: number;
  bot: boolean;
  claimed: boolean;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function parseProfile(body: unknown): AgentProfile | null {
  const a =
    isObj(body) && isObj(body.agent) ? body.agent : isObj(body) && isObj(body.card) ? body.card : null;
  if (!a || typeof a.name !== 'string') return null;
  const bio = isObj(a.bio) ? str(a.bio.untrusted_text) : str(a.bio);
  const fromUrl =
    typeof a.sprite === 'string' ? /\/sprites\/([0-9a-f]+)\.png$/.exec(a.sprite)?.[1] : undefined;
  const hash =
    str(a.sprite_hash) ??
    fromUrl ??
    (typeof a.sprite === 'string' && /^[0-9a-f]{6,64}$/.test(a.sprite) ? a.sprite : null);
  return {
    name: a.name,
    cls: str(a.class) ?? 'warrior',
    level: typeof a.lvl === 'number' ? a.lvl : 1,
    title: str(a.title),
    look: str(a.look),
    bio,
    spriteHash: hash ?? null,
    room: str(a.room),
    achievements: Array.isArray(a.achievements) ? a.achievements.length : 0,
    bot: a.bot === true,
    claimed: a.claimed === true,
  };
}
