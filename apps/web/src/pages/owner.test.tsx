/**
 * The owner pages, rendered with react-dom/server: every state of the claim page and the dashboard, hostile names
 * and notes as plain text, and the API key never leaving the key panel.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/source';
import { Translator } from '../i18n/translator';
import type { OwnerError } from '../owner/client';
import { type OwnerAgent, type OwnerMe, parseMe, parseSummary } from '../owner/parse';
import { summaryView } from '../owner/summaryView';
import { loadCatalog, loadStaticWorld } from '../test/fixtures';
import { AppContext } from '../ui/context';

const en = loadCatalog('en');
const tr = new Translator('en', en, en);

vi.mock('../i18n/store', () => ({
  useT: () => tr,
  i18n: { tr, lang: 'en', subscribe: () => () => undefined, setLang: async () => undefined },
}));
vi.mock('../ui/pageStrings', () => ({}));

const { ClaimView } = await import('./ClaimPage');
const { Dashboard, SignInView, regenerateKey } = await import('./OwnerPage');
const { KeyPanelView, LetterView, NoteEditorView, ShareView, OwnerAgentCard, PushView } = await import('../owner/ui');
const { ownerStore } = await import('../owner/store');

const source: DataSource = {
  kind: 'mock',
  connect: () => undefined,
  setTopics: () => undefined,
  close: () => undefined,
  getJson: async () => null,
  spriteImage: async () => null,
  npcSpriteImage: async () => null,
};
const world = loadStaticWorld();

function html(node: ReactNode): string {
  return renderToStaticMarkup(
    <AppContext.Provider value={{ source, world }}>
      <MemoryRouter>{node}</MemoryRouter>
    </AppContext.Provider>,
  );
}

/** The start of an English string, up to the first character React escapes or a param. */
const has = (out: string, key: string, params?: Record<string, string | number>) => {
  const text = params ? tr.t(key, params) : en[key];
  expect(text, key).toBeTruthy();
  expect(out).toContain(text!.split(/[’'&<>"“”{]/)[0]!.slice(0, 28));
};

const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const noMarkup = (out: string) => {
  expect(out).not.toMatch(/<img src=x|<script/i);
  expect(out).toContain('&lt;script&gt;');
};

const TOKEN = 'Tk_'.padEnd(43, 'x');
const preview = { name: 'Juniper', cls: 'rogue', level: 2, look: 'a nimble halfling', spriteHash: '9e2d5b7a0c3f1648' };
const err = (code: string, extra: Partial<OwnerError> = {}): OwnerError => ({ code, message: '', hint: null, status: 400, retryAfter: null, ...extra });
const providers = { providers: ['github', 'google'], devLogin: false };
const noop = () => undefined;

function claim(over: Partial<Parameters<typeof ClaimView>[0]> = {}) {
  return html(
    <ClaimView
      token={TOKEN}
      load={{ status: 'ready', agent: preview }}
      act={{ status: 'idle' }}
      session="anon"
      ownerName={null}
      providers={providers}
      loginError={null}
      loginRequestError={null}
      busy={false}
      demo={false}
      onClaim={noop}
      onDevLogin={noop}
      onLogout={noop}
      {...over}
    />,
  );
}

describe('claim page', () => {
  it('loading', () => {
    has(claim({ load: { status: 'loading' } }), 'ui.claim.loading');
  });

  it('signed out: the agent, what claiming means, and one login per provider that comes back here', () => {
    const out = claim();
    expect(out).toContain('Juniper');
    expect(out).toContain('a nimble halfling');
    has(out, 'ui.claim.explain', { max: 3 });
    expect(out).toContain('up to 3 agents');
    const next = encodeURIComponent(`/claim/${TOKEN}`);
    expect(out).toContain(`href="/api/owner/login/github?next=${next}"`);
    expect(out).toContain(`href="/api/owner/login/google?next=${next}"`);
    expect(out.match(/referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/gi)?.length).toBe(2);
    expect(out.match(/rel="noreferrer"/g)?.length).toBe(2);
    expect(out).not.toContain(tr.t('ui.owner.dev_login'));
    // The token appears in the two login links (the owner API) and nowhere else on the page.
    expect(out.split(TOKEN).length - 1).toBe(2);
    expect(claim({ providers: { providers: [], devLogin: true } })).toContain(tr.t('ui.owner.dev_login'));
    has(claim({ providers: { providers: [], devLogin: false } }), 'ui.owner.no_login');
  });

  it('signed in: a confirm button and who is signed in', () => {
    const out = claim({ session: 'in', ownerName: 'Ada' });
    expect(out).toContain(tr.t('ui.claim.confirm', { name: 'Juniper' }));
    expect(out).toContain('Signed in as Ada.');
    expect(out).not.toContain('/api/owner/login/');
    has(claim({ session: 'in', ownerName: 'Ada', act: { status: 'working' } }), 'ui.claim.claiming');
  });

  it('unknown or used link', () => {
    const out = claim({ load: { status: 'invalid' } });
    has(out, 'ui.claim.invalid_title');
    has(out, 'ui.claim.invalid_body');
    expect(out).toContain('href="/owner"');
    expect(out).not.toContain(TOKEN);
  });

  it('the 3-agent limit', () => {
    const out = claim({ session: 'in', ownerName: 'Ada', act: { status: 'limit' } });
    expect(out).toContain(tr.t('ui.claim.limit_title', { max: 3 }));
    has(out, 'ui.claim.limit_body');
  });

  it('rate limited, with the wait in words', () => {
    const out = claim({ load: { status: 'rate_limited', error: err('RATE_LIMITED', { status: 429, retryAfter: 1800 }) } });
    has(out, 'ui.claim.rate_title');
    expect(out).toContain('Too many tries. Wait 30');
  });

  it('server or network trouble, and a failed claim', () => {
    has(claim({ load: { status: 'error', error: err('NETWORK') } }), 'ui.owner.error.network');
    has(claim({ session: 'in', ownerName: 'Ada', act: { status: 'error', error: err('INTERNAL', { status: 500 }) } }), 'ui.owner.error.generic');
  });

  it.each(['denied', 'state', 'expired', 'provider', '<script>'])('login error %s', (code) => {
    const out = claim({ loginError: code });
    has(out, `ui.owner.login_error.${code === '<script>' ? 'generic' : code}`);
    expect(out).not.toContain('<script>');
  });

  it('a hostile agent name and look are text', () => {
    const out = claim({ load: { status: 'ready', agent: { ...preview, name: XSS, look: XSS } } });
    noMarkup(out);
  });
});

// ── dashboard ───────────────────────────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 26, 18);

function agentJson(over: Record<string, unknown> = {}) {
  return {
    id: 'a1b',
    name: 'Brisa',
    class: 'cleric',
    level: 7,
    status: 'active',
    title: 'citizen',
    title_text: 'Citizen',
    look: 'a slight elf with silver hair',
    sprite_hash: 'b7e1c2a9d4f05e3a',
    note: 'Try to become mayor.',
    achievements: 6,
    friends: 4,
    last_active_at: NOW - 12 * 60_000,
    seen_at: NOW - 2 * 86_400_000,
    profile_url: 'http://localhost/a/Brisa',
    card_url: 'http://localhost/og/agent/Brisa.png?lang=en',
    ...over,
  };
}

function me(agents: Record<string, unknown>[], ownerName = 'Ada'): OwnerMe {
  return parseMe({ owner: { id: 'o1', name: ownerName, provider: 'github', language: 'en' }, limits: { max_agents: 3, note_max: 280 }, agents, push: { enabled: false, subscriptions: 0 } })!;
}

describe('dashboard', () => {
  it('signed out: what owners get, and the login buttons', () => {
    const out = html(<SignInView providers={providers} loginError={null} error={null} busy={false} demo={false} onDevLogin={noop} />);
    has(out, 'ui.owner.title_anon');
    for (const k of ['summary', 'note', 'key', 'share']) has(out, `ui.owner.perk.${k}`);
    expect(out).toContain('href="/api/owner/login/github?next=%2Fowner"');
    has(out, 'ui.owner.add.title');
    has(html(<SignInView providers={providers} loginError="expired" error={null} busy={false} demo={false} onDevLogin={noop} />), 'ui.owner.login_error.expired');
  });

  it('signed in without agents: how to add one', () => {
    const out = html(<Dashboard me={me([])} selected="" onSelect={noop} />);
    has(out, 'ui.owner.no_agents');
    has(out, 'ui.owner.add.body');
    expect(out).toContain('skill.md');
    expect(out).toContain(tr.t('ui.owner.places', { n: 0, max: 3 }));
  });

  it('two agents, one open: cards, the letter, note, share, key, retire, account', () => {
    const m = me([agentJson(), agentJson({ id: 'a2c', name: 'Torvald', class: 'warrior', level: 12, status: 'retired', note: '' })]);
    const out = html(<Dashboard me={m} selected="a1b" onSelect={noop} />);
    expect(out).toContain('Hello, Ada');
    expect(out).toContain('Brisa');
    expect(out).toContain('Torvald');
    expect(out).toContain(tr.t('ui.owner.status.retired'));
    expect(out).toContain('aria-pressed="true"');
    has(out, 'ui.owner.letter.loading');
    has(out, 'ui.owner.note.explain', { name: 'Brisa' });
    expect(out).toContain('Try to become mayor.');
    expect(out).toContain('src="/og/agent/Brisa.png?lang=en"');
    has(out, 'ui.owner.key.button');
    expect(out).toContain(tr.t('ui.owner.retire.title', { name: 'Brisa' }));
    has(out, 'ui.owner.account.delete_title');
    has(out, 'ui.owner.push.title');
    expect(out).toContain(tr.t('ui.owner.places', { n: 1, max: 3 }));
  });

  it('with several agents and none open, asks to pick one', () => {
    const out = html(<Dashboard me={me([agentJson(), agentJson({ id: 'a2c', name: 'Torvald' })])} selected="" onSelect={noop} />);
    has(out, 'ui.owner.pick');
    expect(out).not.toContain(tr.t('ui.owner.note.title'));
  });

  it('a full house says so in the add box', () => {
    const out = html(<Dashboard me={me([agentJson(), agentJson({ id: 'a2c', name: 'B' }), agentJson({ id: 'a3d', name: 'C' })])} selected="" onSelect={noop} />);
    expect(out).toContain(tr.t('ui.owner.add.full', { max: 3 }));
  });

  it('the letter: the window, the story with icons, highlight links, the signature', () => {
    const agent = me([agentJson()]).agents[0]!;
    const s = parseSummary({
      since: NOW - 30 * 3_600_000,
      until: NOW,
      items: [
        { type: 'levels', text: 'Brisa gained 2 levels and is now level 7.' },
        { type: 'betrayed_by', text: 'Brisa was betrayed by Vex.' },
      ],
      highlights: [{ id: 'h1042', text: 'Vex betrays Brisa!', ts: NOW - 3_600_000 }],
    })!;
    const out = html(<LetterView agent={agent} ownerName="Ada" state={{ status: 'ready', view: summaryView(tr, s, NOW) }} onRetry={noop} />);
    expect(out).toContain('A letter from Brisa');
    expect(out).toContain('Dear Ada,');
    expect(out).toContain('Brisa was betrayed by Vex.');
    expect(out).toContain('href="/h/h1042"');
    expect(out).toMatch(/Since \w+/);
    expect(out).toContain('— Brisa');
    expect(out.match(/class="pixel-icon/g)?.length).toBe(2);
    has(html(<LetterView agent={agent} ownerName="Ada" state={{ status: 'error', error: err('NETWORK') }} onRetry={noop} />), 'ui.owner.error.network');
  });

  it('the note editor: live counter, the cleaned note, over the limit', () => {
    const view = (value: string, saved = 'be kind') =>
      html(<NoteEditorView agentName="Brisa" value={value} saved={saved} max={280} saving={false} error={null} justSaved={false} onChange={noop} onSave={noop} />);
    expect(view('hello')).toContain('5 / 280');
    // Code points, like the server: an emoji is one.
    expect(view('🙂🙂')).toContain('2 / 280');
    const over = view('x'.repeat(281));
    expect(over).toContain('281 / 280');
    expect(over).toContain('is-over');
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*>Save note/);
    expect(view('be kind')).toContain('be kind');
    has(view('', ''), 'ui.owner.note.empty');
  });

  it('notifications: not available, blocked, on, off', () => {
    const p = (state: Parameters<typeof PushView>[0]['state']) => html(<PushView state={state} working={false} error={null} onEnable={noop} onDisable={noop} />);
    has(p('disabled'), 'ui.owner.push.disabled_server');
    expect(p('disabled')).toContain(tr.t('ui.owner.push.unavailable'));
    has(p('unsupported'), 'ui.owner.push.unsupported');
    has(p('denied'), 'ui.owner.push.denied');
    has(p('on'), 'ui.owner.push.disable');
    has(p('off'), 'ui.owner.push.enable');
    expect(p('disabled')).not.toContain('<button');
  });

  it('share: the card, copy link and the announce link in a new tab without opener or referrer', () => {
    const agent = me([agentJson()]).agents[0]!;
    const out = html(<ShareView agent={agent} share={{ text: 't', url: 'http://localhost/a/Brisa', intentUrl: 'https://x.com/intent/post?text=t' }} error={null} copied={false} demo={false} onCopy={noop} />);
    expect(out).toContain('href="https://x.com/intent/post?text=t"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe('agent and owner text is never markup', () => {
  it('names, titles, looks, notes and summaries', () => {
    const m = me([agentJson({ name: XSS, title: XSS, title_text: XSS, look: XSS, note: XSS })], XSS);
    const out = html(<Dashboard me={m} selected="a1b" onSelect={noop} />);
    noMarkup(out);
    const agent: OwnerAgent = m.agents[0]!;
    const s = parseSummary({ since: 1, until: 2, items: [{ type: 'levels', text: XSS }], highlights: [{ id: 'h1', text: XSS, ts: 1 }] })!;
    noMarkup(html(<LetterView agent={agent} ownerName={XSS} state={{ status: 'ready', view: summaryView(tr, s, NOW) }} onRetry={noop} />));
    noMarkup(html(<OwnerAgentCard agent={agent} selected={false} now={NOW} onOpen={noop} />));
    noMarkup(html(<NoteEditorView agentName={XSS} value={XSS} saved={XSS} max={280} saving={false} error={null} justSaved onChange={noop} onSave={noop} />));
  });

  it('server error messages are text too', () => {
    const out = html(<KeyPanelView agent={me([agentJson()]).agents[0]!} phase="idle" keyValue={null} copied={false} error={err('CONFLICT', { message: XSS })} onAsk={noop} onCancel={noop} onConfirm={noop} onCopy={noop} onDone={noop} />);
    noMarkup(out);
  });
});

describe('the API key', () => {
  const KEY = `ajwf_sk_${'K'.repeat(43)}`;
  const writes: string[] = [];
  const storage = () => ({
    getItem: () => null,
    setItem: (k: string, v: string) => void writes.push(`${k}=${v}`),
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });

  beforeEach(() => {
    writes.length = 0;
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/regenerate-key')) return Response.json({ ok: true, api_key: KEY, note: 'shown once' });
        if (url.endsWith('/me'))
          return Response.json({ ok: true, owner: { id: 'o1', name: 'Ada', provider: 'github', language: 'en' }, limits: {}, agents: [agentJson()], push: { enabled: false } });
        return Response.json({ ok: true });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('comes back to the caller only: the owner store and browser storage never see it', async () => {
    await ownerStore.loadMe();
    const before = JSON.stringify(ownerStore.snap);
    const res = await regenerateKey('a1b');
    expect(res).toEqual({ ok: true, key: KEY });
    expect(JSON.stringify(ownerStore.snap)).toBe(before);
    expect(JSON.stringify(ownerStore.snap)).not.toContain('ajwf_sk_');
    expect(writes).toEqual([]);
    // One request, to the right place.
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/regenerate-key'))).toHaveLength(1);
  });

  it('is on the page only while the panel shows it, behind a confirmation that says the old key dies', () => {
    const agent = me([agentJson()]).agents[0]!;
    const view = (phase: 'idle' | 'confirm' | 'shown', keyValue: string | null) =>
      html(<KeyPanelView agent={agent} phase={phase} keyValue={keyValue} copied={false} error={null} onAsk={noop} onCancel={noop} onConfirm={noop} onCopy={noop} onDone={noop} />);
    const confirm = view('confirm', null);
    expect(confirm).toContain(tr.t('ui.owner.key.confirm_body', { name: 'Brisa' }).split(':')[0]);
    expect(confirm).not.toContain('ajwf_sk_');
    const shown = view('shown', KEY);
    expect(shown).toContain(KEY);
    has(shown, 'ui.owner.key.shown_once');
    has(shown, 'ui.owner.key.done');
    // Once dismissed (or the panel closed, which unmounts it), the key is gone from the markup.
    expect(view('idle', null)).not.toContain('ajwf_sk_');
  });

  it('refuses an answer that does not look like a key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, api_key: '<script>' })));
    expect(await regenerateKey('a1b')).toMatchObject({ ok: false, error: { code: 'BAD_RESPONSE' } });
  });
});
