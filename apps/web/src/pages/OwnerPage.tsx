/**
 * `/owner`: "my idle agent". Signed out, a sign-in panel that says what owners get; signed in, one card per agent and,
 * for the open one, a letter from it ("while you were away"), the note it reads, its share card, its key and the
 * door out; then the account (language, notifications, logout, deletion) and how to add another agent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useT } from '../i18n/store';
import type { OwnerError } from '../owner/client';
import { type OwnerAgent, type OwnerMe, type OwnerShare, parseProviders, parseShare, parseSummary, type Providers } from '../owner/parse';
import { currentPushState, disablePush, enablePush, type PushState } from '../owner/push';
import { ownerStore, useOwner } from '../owner/store';
import { summaryView } from '../owner/summaryView';
import {
  AddAgentBox,
  copyText,
  ErrorLine,
  KeyPanelView,
  type KeyPhase,
  LetterView,
  type LetterState,
  LoginButtons,
  loginErrorText,
  NoteEditorView,
  OwnerAgentCard,
  PushView,
  ShareView,
  TypedConfirm,
} from '../owner/ui';
import { ErrorState, Loading, PageShell, PixelIcon, useNow } from '../ui/common';
import '../owner/owner.css';

export default function OwnerPage() {
  const owner = useOwner();
  const tr = useT();
  const [search, setSearch] = useSearchParams();

  useEffect(() => {
    void ownerStore.loadMe();
  }, []);

  const me = owner.me;
  // The site's language is the owner's: letters and notifications follow it.
  const serverLang = me.status === 'ready' ? me.data.owner.language : null;
  const langSent = useRef<string | null>(null);
  useEffect(() => {
    // Once per language: should the server name it differently, this never turns into a loop.
    if (!serverLang || serverLang === tr.lang || langSent.current === tr.lang) return;
    langSent.current = tr.lang;
    let alive = true;
    void ownerStore
      .client()
      .then((c) => c.setLanguage(tr.lang))
      .then((r) => {
        // Looks and titles in /me are written in the owner's language too: read it again.
        if (alive && r.ok) void ownerStore.loadMe();
      });
    return () => {
      alive = false;
    };
  }, [serverLang, tr.lang]);

  if (me.status === 'idle' || me.status === 'loading')
    return (
      <PageShell title={tr.t('ui.owner.kicker')}>
        <Loading />
      </PageShell>
    );
  if (me.status === 'anon') return <SignInPage loginError={search.get('login_error')} />;
  if (me.status === 'error')
    return (
      <PageShell title={tr.t('ui.owner.kicker')}>
        <ErrorState onRetry={() => void ownerStore.loadMe()} />
      </PageShell>
    );
  const param = search.get('agent');
  const selected = param !== null ? param : me.data.agents.length === 1 ? me.data.agents[0]!.id : '';
  return (
    <Dashboard
      me={me.data}
      selected={selected}
      onSelect={(id) => {
        const next = new URLSearchParams(search);
        next.set('agent', id);
        next.delete('login_error');
        setSearch(next, { replace: false });
      }}
    />
  );
}

// ── signed out ──────────────────────────────────────────────────────────────────────────────────────────────

function SignInPage({ loginError }: { loginError: string | null }) {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<OwnerError | null>(null);
  useEffect(() => {
    void ownerStore
      .client()
      .then((c) => c.providers())
      .then((r) => setProviders(r.ok ? parseProviders(r.data) : { providers: [], devLogin: false }));
  }, []);
  return (
    <SignInView
      providers={providers}
      loginError={loginError}
      error={error}
      busy={busy}
      demo={ownerStore.demo}
      onDevLogin={() => {
        setBusy(true);
        void ownerStore.devLogin().then((e) => {
          setError(e);
          setBusy(false);
        });
      }}
    />
  );
}

export function SignInView({
  providers,
  loginError,
  error,
  busy,
  demo,
  onDevLogin,
}: {
  providers: Providers | null;
  loginError: string | null;
  error: OwnerError | null;
  busy: boolean;
  demo: boolean;
  onDevLogin: () => void;
}) {
  const tr = useT();
  const loginText = loginErrorText(tr, loginError);
  const [copied, setCopied] = useState(false);
  return (
    <PageShell title={tr.t('ui.owner.title_anon')} kicker={tr.t('ui.owner.kicker')}>
      <section className="sign-in pixel-box">
        <p className="sign-in-intro">{tr.t('ui.owner.intro_anon')}</p>
        <h2 className="heading heading-sm">{tr.t('ui.owner.perks_title')}</h2>
        <ul className="perks">
          {(
            [
              ['summary', 'scroll'],
              ['note', 'heart'],
              ['key', 'coin'],
              ['share', 'banner'],
            ] as const
          ).map(([k, icon]) => (
            <li key={k}>
              <PixelIcon icon={icon} tone={k === 'key' ? 'gold' : 'teal'} size={20} />
              <span>{tr.t(`ui.owner.perk.${k}`)}</span>
            </li>
          ))}
        </ul>
        {loginText ? (
          <p className="owner-error" role="alert">
            {loginText}
          </p>
        ) : null}
        {providers ? (
          <LoginButtons providers={providers.providers} devLogin={providers.devLogin} next="/owner" demo={demo} busy={busy} onDevLogin={onDevLogin} />
        ) : (
          <Loading />
        )}
        <ErrorLine error={error} />
        <p className="small muted">{tr.t('ui.owner.privacy')}</p>
      </section>
      <AddAgentBox
        origin={typeof window === 'undefined' ? '' : window.location.origin}
        full={false}
        max={3}
        copied={copied}
        onCopy={(text) =>
          void copyText(text).then((ok) => {
            setCopied(ok);
            if (ok) setTimeout(() => setCopied(false), 1800);
          })
        }
      />
    </PageShell>
  );
}

// ── signed in ───────────────────────────────────────────────────────────────────────────────────────────────

export function Dashboard({ me, selected, onSelect }: { me: OwnerMe; selected: string; onSelect: (id: string) => void }) {
  const tr = useT();
  const now = useNow(30_000);
  const [copied, setCopied] = useState(false);
  const active = me.agents.filter((a) => a.status === 'active').length;
  const agent = me.agents.find((a) => a.id === selected) ?? null;
  return (
    <PageShell
      title={tr.t('ui.owner.title', { name: me.owner.name })}
      kicker={tr.t('ui.owner.kicker')}
      wide
      actions={<span className="chip chip-gold">{tr.t('ui.owner.places', { n: active, max: me.limits.maxAgents })}</span>}
    >
      {me.agents.length ? (
        <>
          <h2 className="sr-only">{tr.t('ui.owner.agents_title')}</h2>
          <ul className="owner-cards">
            {me.agents.map((a) => (
              <li key={a.id}>
                <OwnerAgentCard agent={a} selected={a.id === selected} now={now} onOpen={() => onSelect(a.id === selected ? '' : a.id)} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="state-box is-empty pixel-box">
          <PixelIcon icon="scroll" tone="plain" size={36} />
          <p className="state-title">{tr.t('ui.owner.no_agents')}</p>
          <p className="muted">{tr.t('ui.owner.no_agents_body')}</p>
        </div>
      )}

      {agent ? <AgentPanel key={agent.id} agent={agent} me={me} onClose={() => onSelect('')} /> : me.agents.length > 1 ? <p className="muted pick-hint">{tr.t('ui.owner.pick')}</p> : null}

      <div className="owner-bottom">
        <AccountPanel me={me} />
        <AddAgentBox
          origin={typeof window === 'undefined' ? '' : window.location.origin}
          full={active >= me.limits.maxAgents}
          max={me.limits.maxAgents}
          copied={copied}
          onCopy={(text) =>
            void copyText(text).then((ok) => {
              setCopied(ok);
              if (ok) setTimeout(() => setCopied(false), 1800);
            })
          }
        />
      </div>
    </PageShell>
  );
}

/** Everything about one agent. Mounted per agent (`key`), so closing it or switching agents drops its state. */
function AgentPanel({ agent, me, onClose }: { agent: OwnerAgent; me: OwnerMe; onClose: () => void }) {
  const tr = useT();
  const active = agent.status === 'active';
  return (
    <section className="agent-panel" aria-label={agent.name}>
      <div className="agent-panel-head">
        <h2 className="heading section-title">{agent.name}</h2>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {tr.t('ui.owner.close')}
        </button>
      </div>
      <div className="agent-panel-grid">
        <div className="agent-panel-main">
          <Letter agent={agent} ownerName={me.owner.name} ownerLang={me.owner.language} />
          {agent.look ? <p className="agent-look small">{agent.look}</p> : null}
          <KeyPanel agent={agent} />
          {active ? <Retire agent={agent} /> : null}
        </div>
        <div className="agent-panel-side">
          {active ? <NoteEditor agent={agent} max={me.limits.noteMax} /> : null}
          <Share agent={agent} />
        </div>
      </div>
    </section>
  );
}

/** The summary, read once per opening; marked as seen only after it has been on screen for a moment. */
function Letter({ agent, ownerName, ownerLang }: { agent: OwnerAgent; ownerName: string; ownerLang: string }) {
  const tr = useT();
  const [state, setState] = useState<LetterState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const window_ = useRef<{ since: number; until: number } | null>(null);
  const seenSent = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void ownerStore
      .client()
      // Later reads (another language, a retry) ask for the same window: the first read may already be marked seen.
      .then((c) => c.summary(agent.id, window_.current?.since))
      .then((r) => {
        if (!alive) return;
        const s = r.ok ? parseSummary(r.data) : null;
        if (s) {
          window_.current ??= { since: s.since, until: s.until };
          setState({ status: 'ready', view: summaryView(tr, s, Date.now()) });
        } else setState({ status: 'error', error: r.ok ? { code: 'BAD_RESPONSE', message: '', hint: null, status: 200, retryAfter: null } : r.error });
      });
    return () => {
      alive = false;
    };
    // Not on `tr`: the server's text follows the owner's language (`ownerLang`), which follows the page's.
  }, [agent.id, ownerLang, attempt]);

  const ready = state.status === 'ready';
  useEffect(() => {
    const el = box.current;
    const w = window_.current;
    if (!ready || !el || !w || seenSent.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let visible = false;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!visible || document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        seenSent.current = true;
        void ownerStore.client().then((c) => c.markSeen(agent.id, w.until));
      }, 1500);
    };
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            visible = entries.some((e) => e.isIntersecting);
            arm();
          }, { threshold: 0.25 })
        : null;
    if (io) io.observe(el);
    else {
      visible = true;
      arm();
    }
    document.addEventListener('visibilitychange', arm);
    return () => {
      io?.disconnect();
      document.removeEventListener('visibilitychange', arm);
      if (timer) clearTimeout(timer);
    };
  }, [ready, agent.id]);

  return (
    <div ref={box} className="letter-wrap">
      <LetterView agent={agent} ownerName={ownerName} state={state} onRetry={() => setAttempt((n) => n + 1)} />
    </div>
  );
}

function NoteEditor({ agent, max }: { agent: OwnerAgent; max: number }) {
  const [value, setValue] = useState(agent.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<OwnerError | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    const r = await (await ownerStore.client()).setNote(agent.id, value);
    setSaving(false);
    if (!r.ok) return setError(r.error);
    const note = typeof r.data.note === 'string' ? r.data.note : '';
    ownerStore.patchAgent(agent.id, { note });
    // Show what the server kept (links and keys removed), so the owner sees what the agent will read.
    setValue(note);
    setJustSaved(true);
  };
  return (
    <NoteEditorView
      agentName={agent.name}
      value={value}
      saved={agent.note}
      max={max}
      saving={saving}
      error={error}
      justSaved={justSaved}
      onChange={(v) => {
        setValue(v);
        setJustSaved(false);
      }}
      onSave={() => void save()}
    />
  );
}

function Share({ agent }: { agent: OwnerAgent }) {
  const [share, setShare] = useState<OwnerShare | null>(null);
  const [error, setError] = useState<OwnerError | null>(null);
  const [copied, setCopied] = useState(false);
  const tr = useT();
  useEffect(() => {
    let alive = true;
    void ownerStore
      .client()
      .then((c) => c.share(agent.id))
      .then((r) => {
        if (!alive) return;
        const s = r.ok ? parseShare(r.data) : null;
        setShare(s);
        setError(r.ok ? null : r.error);
      });
    return () => {
      alive = false;
    };
  }, [agent.id, tr.lang]);
  return (
    <ShareView
      agent={agent}
      share={share}
      error={error}
      copied={copied}
      demo={ownerStore.demo}
      onCopy={() => {
        if (!share) return;
        void copyText(share.url).then((ok) => {
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 1800);
        });
      }}
    />
  );
}

/**
 * Regenerate the API key. The new key exists only in this component's state: not in the owner store, not in any
 * storage, not in the URL. It is dropped on "I have saved it", when the panel closes, and when the tab is hidden for
 * good (page hide).
 */
export function useKeyFlow(agentId: string) {
  const [phase, setPhase] = useState<KeyPhase>('idle');
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<OwnerError | null>(null);
  const [copied, setCopied] = useState(false);
  const forget = useCallback(() => {
    setKey(null);
    setCopied(false);
    setPhase('idle');
  }, []);
  useEffect(() => {
    window.addEventListener('pagehide', forget);
    return () => window.removeEventListener('pagehide', forget);
  }, [forget]);
  const confirm = async () => {
    setPhase('working');
    setError(null);
    const r = await regenerateKey(agentId);
    if (r.ok) {
      setKey(r.key);
      setPhase('shown');
    } else {
      setError(r.error);
      setPhase('idle');
    }
  };
  return {
    phase,
    key,
    error,
    copied,
    ask: () => {
      setError(null);
      setPhase('confirm');
    },
    cancel: () => setPhase('idle'),
    confirm: () => void confirm(),
    copy: () => {
      if (!key) return;
      void copyText(key).then((ok) => setCopied(ok));
    },
    done: forget,
  };
}

/** The one call that sees a key: it goes from the response straight back to the caller, and nowhere else. */
export async function regenerateKey(agentId: string): Promise<{ ok: true; key: string } | { ok: false; error: OwnerError }> {
  const r = await (await ownerStore.client()).regenerateKey(agentId);
  if (!r.ok) return r;
  const key = r.data.api_key;
  if (typeof key !== 'string' || !/^ajwf_sk_[A-Za-z0-9_-]{20,80}$/.test(key)) return { ok: false, error: { code: 'BAD_RESPONSE', message: '', hint: null, status: 200, retryAfter: null } };
  return { ok: true, key };
}

function KeyPanel({ agent }: { agent: OwnerAgent }) {
  const k = useKeyFlow(agent.id);
  return <KeyPanelView agent={agent} phase={k.phase} keyValue={k.key} copied={k.copied} error={k.error} onAsk={k.ask} onCancel={k.cancel} onConfirm={k.confirm} onCopy={k.copy} onDone={k.done} />;
}

function Retire({ agent }: { agent: OwnerAgent }) {
  const tr = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<OwnerError | null>(null);
  return (
    <TypedConfirm
      title={tr.t('ui.owner.retire.title', { name: agent.name })}
      explain={tr.t('ui.owner.retire.explain', { name: agent.name })}
      word={agent.name}
      openLabel={tr.t('ui.owner.retire.button')}
      confirmLabel={tr.t('ui.owner.retire.confirm', { name: agent.name })}
      working={working}
      error={error}
      onConfirm={() => {
        setWorking(true);
        void ownerStore.client().then(async (c) => {
          const r = await c.retire(agent.id);
          setWorking(false);
          if (!r.ok) return setError(r.error);
          ownerStore.patchAgent(agent.id, { status: 'retired' });
        });
      }}
    />
  );
}

// ── account ─────────────────────────────────────────────────────────────────────────────────────────────────

function AccountPanel({ me }: { me: OwnerMe }) {
  const tr = useT();
  const [push, setPush] = useState<PushState | 'checking'>('checking');
  const [pushWorking, setPushWorking] = useState(false);
  const [pushError, setPushError] = useState<OwnerError | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<OwnerError | null>(null);
  const [logoutError, setLogoutError] = useState<OwnerError | null>(null);

  useEffect(() => {
    void currentPushState(me.push.enabled).then(setPush);
  }, [me.push.enabled]);

  const togglePush = (on: boolean) => {
    setPushWorking(true);
    setPushError(null);
    void ownerStore.client().then(async (c) => {
      const r = on ? await enablePush(c) : await disablePush(c);
      setPush(r.state);
      if (!r.ok) setPushError(r.error);
      setPushWorking(false);
    });
  };

  return (
    <section className="vcard pixel-box account">
      <h2 className="heading section-title">
        <PixelIcon icon="crown" tone="plain" /> {tr.t('ui.owner.account.title')}
      </h2>
      <p className="small">{tr.t('ui.owner.account.signed_in', { name: me.owner.name, provider: tr.maybe(`ui.owner.provider.${me.owner.provider}`) ?? me.owner.provider })}</p>
      <p className="small muted">{tr.t('ui.owner.account.language')}</p>
      <PushView state={push} working={pushWorking} error={pushError} onEnable={() => togglePush(true)} onDisable={() => togglePush(false)} />
      <div className="row-actions">
        <button
          type="button"
          className="btn"
          onClick={() =>
            void ownerStore.logout().then((e) => {
              setLogoutError(e);
            })
          }
        >
          {tr.t('ui.owner.account.logout')}
        </button>
      </div>
      <ErrorLine error={logoutError} />
      <TypedConfirm
        title={tr.t('ui.owner.account.delete_title')}
        explain={tr.t('ui.owner.account.delete_explain')}
        word={tr.t('ui.owner.account.delete_word')}
        openLabel={tr.t('ui.owner.account.delete_button')}
        confirmLabel={tr.t('ui.owner.account.delete_confirm')}
        working={deleting}
        error={deleteError}
        onConfirm={() => {
          setDeleting(true);
          void ownerStore.client().then(async (c) => {
            const r = await c.deleteAccount();
            setDeleting(false);
            if (!r.ok) return setDeleteError(r.error);
            ownerStore.signedOut();
          });
        }}
      />
    </section>
  );
}
