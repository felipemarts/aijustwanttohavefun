import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { WorldState } from '@ajwf/engine';
import type { GameEvent, MsgParams } from '@ajwf/shared';
import { sendNotification, WebPushError } from 'web-push';
import type { Logger } from 'pino';
import type { Vapid } from '../config';
import type { EventConsumer, Game } from '../game';
import { RateLimiter } from '../rate-limit';
import type { Renderer } from '../render';
import type { PushKeys, PushSubscriptionRow, Store } from '../store/types';

// ── subscription validation ─────────────────────────────────────────────────────────────────────────────────

/**
 * Addresses a push endpoint may never point at: loopback, private, link-local, CGNAT, multicast, reserved. IPv4 rules
 * also match IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`).
 */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  // Unspecified, loopback and the deprecated IPv4-compatible range (`::127.0.0.1`).
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  // Teredo and 6to4 embed an IPv4 address (`2002:7f00:1::` is 127.0.0.1) that a relay may reach.
  ['2001::', 32],
  ['2002::', 16],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED.addSubnet(net, bits, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  return !BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.private'];
const B64URL = /^[A-Za-z0-9_-]+=*$/;

/**
 * A browser push subscription the server may send to: an https URL on the default port, without credentials, whose
 * host is a public DNS name or public IP, plus well-formed keys. Hosts are checked again when connecting (see
 * `safeLookup`), so DNS names that resolve to private addresses are refused too.
 */
export function validSubscription(endpoint: unknown, keys: unknown): { endpoint: string; keys: PushKeys } | null {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return null;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  // A trailing dot ("localhost.") names the same host.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host || host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  if (isIP(host)) {
    if (!isPublicAddress(host)) return null;
  } else if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
  const k = keys as Partial<PushKeys> | null;
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return null;
  if (!B64URL.test(k.p256dh) || !B64URL.test(k.auth) || k.p256dh.length < 80 || k.p256dh.length > 100 || k.auth.length < 16 || k.auth.length > 32) return null;
  return { endpoint: u.toString(), keys: { p256dh: k.p256dh, auth: k.auth } };
}

/** DNS lookup that refuses private and loopback answers (no SSRF through a public name pointing inside). */
export const safeLookup = ((hostname: string, options: { all?: boolean }, cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) return cb(new Error('push endpoint resolves to a non-public address'));
    if (options.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}) as unknown as typeof dnsLookup;

// ── sending ─────────────────────────────────────────────────────────────────────────────────────────────────

export type PushResult = { ok: true } | { ok: false; gone: boolean };

/** Sends one encrypted push message. Injectable: tests use a fake. */
export interface PushSender {
  send(sub: { endpoint: string; keys: PushKeys }, payload: string): Promise<PushResult>;
}

/** Real sender: web-push with the VAPID keys, through an agent whose DNS lookup refuses private addresses. */
export class WebPushSender implements PushSender {
  private agent = new Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 16 });

  constructor(private vapid: Vapid) {}

  async send(sub: { endpoint: string; keys: PushKeys }, payload: string): Promise<PushResult> {
    try {
      await sendNotification(sub, payload, { vapidDetails: this.vapid, TTL: 24 * 3600, timeout: 10_000, agent: this.agent, urgency: 'normal' });
      return { ok: true };
    } catch (err) {
      const status = err instanceof WebPushError ? err.statusCode : 0;
      return { ok: false, gone: status === 404 || status === 410 };
    }
  }
}

// ── big moments ─────────────────────────────────────────────────────────────────────────────────────────────

/** Notifications per owner per hour. */
export const PUSH_PER_HOUR = 4;

export type Moment = { type: string; agentId: string; params: MsgParams };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The moments worth a notification (§14.2), from public game events: a rare achievement (world first or one that
 * grants a title), elected mayor, a betrayal committed or suffered, killed by a boss or by another agent, levels
 * 10 and 20, and the fountain's jackpot. Pure: returns `[agent id, moment]` pairs for agents that have an owner.
 */
export function momentsOf(ev: GameEvent, s: WorldState, owned: (agentId: string) => boolean): Moment[] {
  const out: Moment[] = [];
  const name = (id: string | undefined) => (id ? (s.agents.get(id)?.name ?? '') : '');
  const add = (agentId: string | undefined, type: string, params: MsgParams) => {
    if (agentId && owned(agentId)) out.push({ type, agentId, params: { name: name(agentId), ...params } });
  };
  const p = ev.payload;
  switch (ev.type) {
    case 'achievement': {
      const ach = s.content.achievements.get(str(p.ach));
      if (p.world_first === true || ach?.title) add(ev.actor, 'achievement', { ach: `@ach:${str(p.ach)}` });
      break;
    }
    case 'election_result':
      add(ev.actor, 'mayor', {});
      break;
    case 'betrayal':
      add(ev.actor, 'betrayal_committed', { other: name(ev.target) || str(p.victim) });
      add(ev.target, 'betrayal_suffered', { other: name(ev.actor) || str(p.traitor) });
      break;
    case 'fallen': {
      const by = str(p.by);
      if (p.pvp === true) add(ev.actor, 'killed_by_agent', { other: by });
      else if (by.startsWith('@mon:')) {
        const m = s.content.monsters.get(by.slice(5));
        if (m?.boss || m?.world_boss) add(ev.actor, 'killed_by_boss', { mon: by });
      }
      break;
    }
    case 'level_up': {
      const level = typeof p.level === 'number' ? p.level : 0;
      if (level === 10 || level === 20) add(ev.actor, 'level', { level });
      break;
    }
    case 'fountain_jackpot':
      add(ev.actor, 'jackpot', { gold: typeof p.gold === 'number' ? p.gold : 0 });
      break;
  }
  return out;
}

export type PushDeps = { game: Game; store: Store; render: Renderer; sender: PushSender; publicUrl: string; log: Logger };

/**
 * Turns big moments of owned agents into Web Push messages: title and body rendered from `owner.push.*` in the
 * owner's language plus a link, never agent-written text. Rate-limited per owner; dead subscriptions are removed.
 */
export class PushNotifier implements EventConsumer {
  readonly name = 'push';
  private limiter = new RateLimiter(PUSH_PER_HOUR, 3_600_000);
  private inflight = new Set<Promise<void>>();

  constructor(private d: PushDeps) {}

  consume(events: readonly GameEvent[]): void {
    const { game } = this.d;
    for (const ev of events) {
      for (const m of momentsOf(ev, game.state, (id) => game.ownerOf(id) !== undefined)) {
        const owner = game.ownerOf(m.agentId)!;
        if (!this.limiter.take(owner, game.now()).ok) continue;
        const job = this.deliver(owner, m).catch((err: unknown) => this.d.log.warn({ err }, 'push delivery failed'));
        this.inflight.add(job);
        void job.finally(() => this.inflight.delete(job));
      }
    }
  }

  /** Resolves when every message queued so far was handled (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** The notification as sent: rendered texts and a link to the agent's profile. */
  payload(lang: string, m: Moment): string {
    const { render } = this.d;
    const name = str(m.params.name);
    return JSON.stringify({
      title: render.t(lang, `owner.push.${m.type}.title`, m.params),
      body: render.t(lang, `owner.push.${m.type}.body`, m.params),
      url: `${this.d.publicUrl}/a/${encodeURIComponent(name)}`,
      tag: `${m.type}:${m.agentId}`,
    });
  }

  private async deliver(ownerId: string, m: Moment): Promise<void> {
    const { store, sender } = this.d;
    const [owner, subs] = await Promise.all([store.getOwner(ownerId), store.listPushSubscriptions(ownerId)]);
    if (!owner || !subs.length) return;
    const body = this.payload(this.d.render.lang(owner.language), m);
    await Promise.all(
      subs.map(async (sub: PushSubscriptionRow) => {
        const res = await sender.send({ endpoint: sub.endpoint, keys: sub.keys }, body);
        if (!res.ok && res.gone) await store.deletePushSubscription(sub.endpoint);
      }),
    );
  }
}
