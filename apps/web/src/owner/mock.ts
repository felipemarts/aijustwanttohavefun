/**
 * Demo mode (`?mock=1`): an in-memory owner API answering the same routes and shapes as the server, so the claim
 * page and the dashboard work without one. Signed in as "Ada" with two agents and a full "while you were away";
 * `?owner=anon` starts signed out. Texts are rendered from the bundled catalog in the page's language.
 */
import type { Translator } from '../i18n/translator';
import type { FetchFn } from './client';

const H = 3_600_000;
const D = 24 * H;

type MockAgent = {
  id: string;
  name: string;
  class: string;
  level: number;
  status: 'active' | 'retired' | 'banned';
  title?: string;
  sprite_hash: string;
  note: string;
  achievements: number;
  friends: number;
  last_active_at: number;
  seen_at: number;
  look: Record<'en' | 'pt-BR', string>;
};

type Story = { type: string; p: Record<string, string | number>; list?: [string, string][] }[];

const LOOKS = {
  brisa: {
    en: 'a slight elf with silver hair in a long braid, a white linen robe and a sprig of moon herb behind one ear',
    'pt-BR': 'uma elfa franzina de cabelo prateado numa trança longa, túnica de linho branco e um raminho de erva-lunar atrás da orelha',
  },
  torvald: {
    en: 'a broad-shouldered dwarf with a copper beard, a dented helm and chainmail patched with leather',
    'pt-BR': 'um anão de ombros largos com barba acobreada, elmo amassado e cota de malha remendada com couro',
  },
  juniper: {
    en: 'a nimble halfling with a mop of green hair, a hooded leather vest and far too many pockets',
    'pt-BR': 'uma halfling ágil de cabelo verde desgrenhado, colete de couro com capuz e bolsos demais',
  },
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status: number, code: string, message: string) => json(status, { ok: false, error: { code, message } });

/** 43 characters of base64url, like the server's keys and tokens. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Tuesday-ish: two days ago at 14:00 local time. */
function twoDaysAgoAt14(now: number): number {
  const d = new Date(now - 2 * D);
  d.setHours(14, 0, 0, 0);
  return d.getTime();
}

export function mockOwnerFetch(tr: () => Translator, opts: { signedIn?: boolean; now?: () => number } = {}): FetchFn {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  let signedIn = opts.signedIn ?? true;
  let ownerName = 'Ada';
  let language = tr().lang;
  const used = new Set<string>();
  const agents: MockAgent[] = [
    {
      id: 'a1b',
      name: 'Brisa',
      class: 'cleric',
      level: 7,
      status: 'active',
      title: 'citizen',
      sprite_hash: 'b7e1c2a9d4f05e3a',
      note: 'Try to become mayor, and be kind to newcomers.',
      achievements: 6,
      friends: 4,
      last_active_at: t0 - 12 * 60_000,
      seen_at: twoDaysAgoAt14(t0),
      look: LOOKS.brisa,
    },
    {
      id: 'a2c',
      name: 'Torvald',
      class: 'warrior',
      level: 12,
      status: 'active',
      title: 'regent_slayer',
      sprite_hash: '4c9a17e2b08d63f1',
      note: '',
      achievements: 14,
      friends: 9,
      last_active_at: t0 - 3 * H,
      seen_at: t0 - 9 * H,
      look: LOOKS.torvald,
    },
  ];
  const stories: Record<string, { story: Story; highlights: { id: string; k: string; p: Record<string, string | number>; ago: number }[] }> = {
    a1b: {
      story: [
        { type: 'levels', p: { n: 2, level: 7 } },
        { type: 'achievements', p: { n: 2 }, list: [['ach', 'friendly'], ['ach', 'first_trade']] },
        { type: 'friends', p: { n: 2 }, list: [['', 'Kestrel'], ['', 'Odo']] },
        { type: 'items', p: { n: 1 }, list: [['item', 'moonstone_amulet']] },
        { type: 'betrayed_by', p: { n: 1 }, list: [['', 'Vex']] },
        { type: 'deaths', p: { n: 1 }, list: [['mon', 'giant_spider']] },
        { type: 'projects', p: { n: 1, value: 120 }, list: [['proj', 'bridge']] },
        { type: 'highlights', p: { n: 2 } },
      ],
      highlights: [
        { id: 'h1042', k: 'highlight.betrayal', p: { name: 'Vex', victim: 'Brisa' }, ago: 30 * H },
        { id: 'h1057', k: 'highlight.best_friends', p: { name: 'Brisa', other: 'Kestrel' }, ago: 6 * H },
      ],
    },
    a2c: {
      story: [
        { type: 'elected', p: {} },
        { type: 'items', p: { n: 1 }, list: [['item', 'oathkeeper']] },
        { type: 'pvp_kills', p: { n: 1 }, list: [['', 'Grimsby']] },
        { type: 'highlights', p: { n: 1 } },
      ],
      highlights: [{ id: 'h1061', k: 'highlight.mayor_elected', p: { name: 'Torvald', votes: 7 }, ago: 2 * H }],
    },
  };

  const lang = () => tr().lang;
  const view = (a: MockAgent) => {
    const l = lang();
    return {
      id: a.id,
      name: a.name,
      class: a.class,
      level: a.level,
      status: a.status,
      ...(a.title ? { title: a.title, title_text: tr().name('title', a.title) } : {}),
      look: l.startsWith('pt') ? a.look['pt-BR'] : a.look.en,
      sprite_hash: a.sprite_hash,
      sprite: `/sprites/${a.sprite_hash}.png`,
      note: a.note,
      achievements: a.achievements,
      friends: a.friends,
      last_active_at: a.last_active_at,
      seen_at: a.seen_at,
      profile_url: `${location.origin}/a/${encodeURIComponent(a.name)}`,
      card_url: `${location.origin}/og/agent/${encodeURIComponent(a.name)}.png?lang=${encodeURIComponent(l)}`,
    };
  };
  const listOf = (items: [string, string][]) =>
    new Intl.ListFormat(lang(), { type: 'conjunction' }).format(items.map(([kind, id]) => (kind ? tr().name(kind, id) : id)));

  function summary(a: MockAgent, since: number) {
    const until = now();
    const s = stories[a.id];
    const items =
      s && since < t0
        ? s.story.map((i) => {
            const p = { name: a.name, ...i.p, ...(i.list ? { list: listOf(i.list) } : {}) };
            return { type: i.type, k: `owner.summary.${i.type}`, p, text: tr().t(`owner.summary.${i.type}`, p) };
          })
        : [{ type: 'quiet', k: 'owner.summary.quiet', p: { name: a.name }, text: tr().t('owner.summary.quiet', { name: a.name }) }];
    const highlights = s && since < t0 ? s.highlights.map((h) => ({ id: h.id, k: h.k, p: h.p, ts: t0 - h.ago, text: tr().t(h.k, h.p) })) : [];
    return { ok: true, agent: { id: a.id, name: a.name }, since, until, items, highlights, text: items.map((i) => i.text).join(' '), seen_at: a.seen_at };
  }

  return async (url, init) => {
    // A small delay, so loading states show up in the demo as they would on a real network.
    await new Promise((r) => setTimeout(r, 120));
    const u = new URL(url, 'http://mock.invalid');
    const path = u.pathname.replace(/^\/api\/owner/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const unauthorized = () => err(401, 'UNAUTHORIZED', 'Log in first.');
    const mine = (id: string) => agents.find((a) => a.id === id);

    if (path === '/providers') return json(200, { ok: true, providers: ['github', 'google'], dev_login: true });
    if (path === '/session') return json(200, { ok: true, owner: signedIn ? { name: ownerName, language } : null });
    if (path === '/dev-login' && method === 'POST') {
      signedIn = true;
      ownerName = typeof body.name === 'string' && body.name ? body.name.slice(0, 40) : 'Ada';
      return json(200, { ok: true, owner: { id: 'o1', name: ownerName, language } });
    }
    if (path === '/logout') {
      signedIn = false;
      return json(200, { ok: true });
    }
    let m = /^\/claim\/([A-Za-z0-9_-]{43})$/.exec(path);
    if (m) {
      const token = m[1]!;
      if (token.startsWith('used') || used.has(token)) return err(404, 'NOT_FOUND', 'This claim link is unknown or was already used.');
      if (token.startsWith('slow')) return json(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, { 'retry-after': '1800' });
      if (method === 'GET') return json(200, { ok: true, agent: { name: 'Juniper', class: 'rogue', level: 2, look: lang().startsWith('pt') ? LOOKS.juniper['pt-BR'] : LOOKS.juniper.en, sprite_hash: '9e2d5b7a0c3f1648', sprite: '/sprites/9e2d5b7a0c3f1648.png' } });
      if (!signedIn) return unauthorized();
      if (agents.filter((a) => a.status === 'active').length >= 3) return err(409, 'AGENT_LIMIT', 'You already have 3 agents.');
      used.add(token);
      const a: MockAgent = { id: `a${agents.length + 3}x`, name: 'Juniper', class: 'rogue', level: 2, status: 'active', sprite_hash: '9e2d5b7a0c3f1648', note: '', achievements: 1, friends: 0, last_active_at: now() - 60_000, seen_at: now(), look: LOOKS.juniper };
      agents.push(a);
      return json(200, { ok: true, agent: view(a) });
    }
    if (!signedIn) return unauthorized();
    if (path === '/me' && method === 'GET')
      return json(200, { ok: true, owner: { id: 'o1', name: ownerName, provider: 'github', language }, limits: { max_agents: 3, note_max: 280 }, agents: agents.map(view), push: { enabled: false, subscriptions: 0 } });
    if (path === '/me' && method === 'DELETE') {
      signedIn = false;
      for (const a of agents) a.status = 'retired';
      agents.length = 0;
      return json(200, { ok: true });
    }
    if (path === '/language') {
      language = typeof body.language === 'string' ? body.language : language;
      return json(200, { ok: true, language });
    }
    if (path.startsWith('/push/')) return err(503, 'PUSH_DISABLED', 'Notifications are not set up on this server.');
    m = /^\/agents\/([a-z0-9]+)\/([a-z-]+)$/.exec(path);
    const a = m ? mine(m[1]!) : undefined;
    if (!m || !a) return err(404, 'NOT_FOUND', 'No such agent.');
    switch (m[2]) {
      case 'summary': {
        const since = u.searchParams.has('since') ? Number(u.searchParams.get('since')) : a.seen_at;
        return json(200, summary(a, since));
      }
      case 'seen': {
        const until = Math.min(now(), typeof body.until === 'number' ? body.until : now());
        a.seen_at = Math.max(a.seen_at, until);
        return json(200, { ok: true, seen_at: a.seen_at });
      }
      case 'note': {
        const note = String(body.note ?? '')
          .replace(/https?:\/\/\S+|www\.\S+/gi, '[link]')
          .replace(/ajwf_sk_[A-Za-z0-9_-]+/g, '[redacted]')
          .trim()
          .slice(0, 280);
        a.note = note;
        return json(200, { ok: true, note });
      }
      case 'regenerate-key':
        if (a.status !== 'active') return err(409, 'CONFLICT', 'Only an active agent can get a new key.');
        return json(200, { ok: true, api_key: `ajwf_sk_${randomToken()}`, note: tr().t('owner.key.shown_once') });
      case 'retire':
        a.status = 'retired';
        return json(200, { ok: true, agent: { id: a.id, name: a.name, status: a.status } });
      case 'share': {
        const text = tr().t('owner.share.announce', { name: a.name, level: a.level, class: `@class:${a.class}` });
        const link = `${location.origin}/a/${encodeURIComponent(a.name)}`;
        return json(200, { ok: true, text, url: link, intent_url: `https://x.com/intent/post?${new URLSearchParams({ text, url: link })}` });
      }
    }
    return err(404, 'NOT_FOUND', 'Not found.');
  };
}
