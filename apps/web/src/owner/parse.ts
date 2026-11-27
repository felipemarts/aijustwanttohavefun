/**
 * Parsers of the owner API's answers. Same rules as the public ones: untrusted JSON checked field by field, unknown
 * fields ignored, ids and hashes validated before they can become part of a URL.
 */
import { arr, isNum, isObj, isStr, num, str, strOrNull } from '../data/parse';

const AGENT_ID = /^a[0-9a-z]{1,12}$/;
const HASH = /^[0-9a-f]{6,64}$/;
const STATUSES = ['active', 'retired', 'banned'] as const;
export type AgentStatus = (typeof STATUSES)[number];

export type OwnerAgent = {
  id: string;
  name: string;
  cls: string;
  level: number;
  status: AgentStatus;
  /** Title id and its text in the owner's language. */
  title: string | null;
  titleText: string | null;
  look: string;
  spriteHash: string;
  /** The cleaned note the agent reads (what the server stored, not what was typed). */
  note: string;
  achievements: number;
  friends: number;
  lastActiveAt: number;
  seenAt: number | null;
  /** The profile's absolute URL on the public site (for copying). */
  profileUrl: string;
  /** The share card, as a path on this site (`card_url` without its host). */
  cardPath: string;
};

export type OwnerMe = {
  owner: { id: string; name: string; provider: string; language: string };
  limits: { maxAgents: number; noteMax: number };
  agents: OwnerAgent[];
  push: { enabled: boolean; subscriptions: number };
};

export type SummaryItem = { type: string; text: string };
export type SummaryHighlight = { id: string; text: string; ts: number };
export type OwnerSummary = { since: number; until: number; items: SummaryItem[]; highlights: SummaryHighlight[] };
export type OwnerShare = { text: string; url: string; intentUrl: string };
export type Providers = { providers: string[]; devLogin: boolean };
export type ClaimPreview = { name: string; cls: string; level: number; look: string; spriteHash: string };
export type SessionInfo = { name: string; language: string } | null;

const short = (v: unknown, max: number, d = '') => str(v, d).slice(0, max);

export function parseOwnerAgent(v: unknown): OwnerAgent | null {
  if (!isObj(v) || !isStr(v.id) || !AGENT_ID.test(v.id) || !isStr(v.name) || !v.name) return null;
  const status = (STATUSES as readonly unknown[]).includes(v.status) ? (v.status as AgentStatus) : 'active';
  const hash = str(v.sprite_hash);
  return {
    id: v.id,
    name: v.name.slice(0, 64),
    cls: short(v.class, 20, 'warrior'),
    level: Math.max(1, Math.floor(num(v.level, 1))),
    status,
    title: strOrNull(v.title),
    titleText: strOrNull(v.title_text),
    look: short(v.look, 600),
    spriteHash: HASH.test(hash) ? hash : '',
    note: short(v.note, 600),
    achievements: Math.max(0, num(v.achievements)),
    friends: Math.max(0, num(v.friends)),
    lastActiveAt: num(v.last_active_at),
    seenAt: isNum(v.seen_at) ? v.seen_at : null,
    profileUrl: short(v.profile_url, 300),
    cardPath: ogAgentPath(v.card_url) ?? cardPath(v.name, 'en'),
  };
}

export function parseMe(body: Record<string, unknown>): OwnerMe | null {
  const o = body.owner;
  if (!isObj(o) || !isStr(o.id)) return null;
  const limits = isObj(body.limits) ? body.limits : {};
  const push = isObj(body.push) ? body.push : {};
  return {
    owner: { id: o.id, name: short(o.name, 64), provider: short(o.provider, 20), language: short(o.language, 35, 'en') },
    limits: { maxAgents: Math.max(1, num(limits.max_agents, 3)), noteMax: Math.max(1, num(limits.note_max, 280)) },
    agents: arr(body.agents).flatMap((a) => {
      const p = parseOwnerAgent(a);
      return p ? [p] : [];
    }),
    push: { enabled: push.enabled === true, subscriptions: Math.max(0, num(push.subscriptions)) },
  };
}

export function parseSummary(body: Record<string, unknown>): OwnerSummary | null {
  if (!isNum(body.since) || !isNum(body.until)) return null;
  return {
    since: body.since,
    until: body.until,
    items: arr(body.items).flatMap((i) => (isObj(i) && isStr(i.type) && isStr(i.text) ? [{ type: i.type, text: i.text }] : [])),
    highlights: arr(body.highlights).flatMap((h) =>
      isObj(h) && isStr(h.id) && /^h\d{1,15}(-\d+)?$/.test(h.id) && isStr(h.text) ? [{ id: h.id, text: h.text, ts: num(h.ts) }] : [],
    ),
  };
}

/** Only an X / Twitter intent link can be opened from the share box: never an arbitrary URL from a response. */
export function safeIntentUrl(v: unknown): string | null {
  if (!isStr(v)) return null;
  try {
    const u = new URL(v);
    const ok = u.protocol === 'https:' && (u.hostname === 'x.com' || u.hostname === 'twitter.com') && u.pathname.startsWith('/intent/');
    return ok ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseShare(body: Record<string, unknown>): OwnerShare | null {
  const intentUrl = safeIntentUrl(body.intent_url);
  if (!intentUrl || !isStr(body.url)) return null;
  return { text: short(body.text, 600), url: short(body.url, 300), intentUrl };
}

export function parseProviders(body: Record<string, unknown>): Providers {
  return { providers: arr(body.providers).filter((p): p is string => isStr(p) && /^[a-z]{2,20}$/.test(p)), devLogin: body.dev_login === true };
}

export function parseClaimPreview(body: Record<string, unknown>): ClaimPreview | null {
  const a = body.agent;
  if (!isObj(a) || !isStr(a.name) || !a.name) return null;
  const hash = str(a.sprite_hash);
  return { name: a.name.slice(0, 64), cls: short(a.class, 20, 'warrior'), level: Math.max(1, num(a.level, 1)), look: short(a.look, 600), spriteHash: HASH.test(hash) ? hash : '' };
}

export function parseSession(body: Record<string, unknown>): SessionInfo {
  const o = body.owner;
  return isObj(o) && isStr(o.name) ? { name: o.name.slice(0, 64), language: short(o.language, 35, 'en') } : null;
}

/**
 * `card_url` as a path on this site: the server names its public host, which during development is not the page's
 * (the Vite server proxies `/og`). Anything that is not an agent card path is refused.
 */
export function ogAgentPath(v: unknown): string | null {
  if (!isStr(v)) return null;
  try {
    const u = new URL(v, 'http://x.invalid');
    return /^\/og\/agent\/[^/]+\.png$/.test(u.pathname) ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

/** The share card of an agent, from this site. */
export function cardPath(name: string, lang: string): string {
  return `/og/agent/${encodeURIComponent(name)}.png?lang=${encodeURIComponent(lang)}`;
}
