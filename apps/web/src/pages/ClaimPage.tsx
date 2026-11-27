/**
 * `/claim/:token`: the page a person opens from the link their agent sent. It shows the agent, says in two sentences
 * what claiming means, and either offers to sign in (coming back here) or to confirm.
 *
 * The token goes to the owner API and nowhere else: it is not logged, not stored, not put in the store, and the page
 * never sends its URL as a referrer (a `no-referrer` meta while it is open; the server sends the same header).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useT } from '../i18n/store';
import type { OwnerError } from '../owner/client';
import { type ClaimPreview, parseClaimPreview, parseOwnerAgent, parseProviders, type Providers } from '../owner/parse';
import { ownerStore, useOwner } from '../owner/store';
import { ErrorLine, LoginButtons, loginErrorText, ownerErrorText } from '../owner/ui';
import { Loading, PageShell, PixelIcon } from '../ui/common';
import { SpriteFrame } from '../ui/SpriteFrame';
import '../owner/owner.css';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Agents one person may own (the server says so again if it changes). */
const MAX_AGENTS = 3;

export type ClaimLoad =
  | { status: 'loading' }
  | { status: 'invalid' }
  | { status: 'rate_limited'; error: OwnerError }
  | { status: 'error'; error: OwnerError }
  | { status: 'ready'; agent: ClaimPreview };

export type ClaimAct = { status: 'idle' } | { status: 'working' } | { status: 'limit' } | { status: 'error'; error: OwnerError };

/** While mounted, the document sends no referrer at all (outgoing links, images, the provider redirect). */
function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

export default function ClaimPage() {
  const { token = '' } = useParams();
  const [search] = useSearchParams();
  const tr = useT();
  const owner = useOwner();
  const navigate = useNavigate();
  const valid = TOKEN_RE.test(token);
  const [load, setLoad] = useState<ClaimLoad>(valid ? { status: 'loading' } : { status: 'invalid' });
  const [providers, setProviders] = useState<Providers | null>(null);
  const [act, setAct] = useState<ClaimAct>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [loginErr, setLoginErr] = useState<OwnerError | null>(null);
  useNoReferrer();

  useEffect(() => {
    void ownerStore.checkSession(true);
    void ownerStore
      .client()
      .then((c) => c.providers())
      .then((r) => setProviders(r.ok ? parseProviders(r.data) : { providers: [], devLogin: false }));
  }, []);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    void ownerStore
      .client()
      .then((c) => c.claimPreview(token, tr.lang))
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          const agent = parseClaimPreview(r.data);
          setLoad(agent ? { status: 'ready', agent } : { status: 'invalid' });
        } else if (r.error.code === 'NOT_FOUND') setLoad({ status: 'invalid' });
        else if (r.error.code === 'RATE_LIMITED') setLoad({ status: 'rate_limited', error: r.error });
        else setLoad({ status: 'error', error: r.error });
      });
    return () => {
      alive = false;
    };
  }, [token, valid, tr.lang]);

  const claim = async () => {
    setAct({ status: 'working' });
    const r = await (await ownerStore.client()).claim(token);
    if (r.ok) {
      const a = parseOwnerAgent(r.data.agent);
      await ownerStore.loadMe();
      // `replace`: the used link leaves the history.
      navigate(a ? `/owner?agent=${encodeURIComponent(a.id)}` : '/owner', { replace: true });
      return;
    }
    if (r.error.code === 'AGENT_LIMIT') setAct({ status: 'limit' });
    else if (r.error.code === 'NOT_FOUND') setLoad({ status: 'invalid' });
    else if (r.error.code === 'UNAUTHORIZED') {
      ownerStore.signedOut();
      setAct({ status: 'idle' });
    } else setAct({ status: 'error', error: r.error });
  };

  const devLogin = async () => {
    setBusy(true);
    setLoginErr(await ownerStore.devLogin());
    setBusy(false);
  };

  const logout = async () => {
    setBusy(true);
    await ownerStore.logout();
    setBusy(false);
  };

  return (
    <ClaimView
      token={token}
      load={load}
      act={act}
      session={owner.session}
      ownerName={owner.name}
      providers={providers}
      loginError={search.get('login_error')}
      loginRequestError={loginErr}
      busy={busy}
      demo={ownerStore.demo}
      onClaim={() => void claim()}
      onDevLogin={() => void devLogin()}
      onLogout={() => void logout()}
    />
  );
}

export function ClaimView({
  token,
  load,
  act,
  session,
  ownerName,
  providers,
  loginError,
  loginRequestError,
  busy,
  demo,
  onClaim,
  onDevLogin,
  onLogout,
}: {
  token: string;
  load: ClaimLoad;
  act: ClaimAct;
  session: 'unknown' | 'anon' | 'in';
  ownerName: string | null;
  providers: Providers | null;
  loginError: string | null;
  loginRequestError: OwnerError | null;
  busy: boolean;
  demo: boolean;
  onClaim: () => void;
  onDevLogin: () => void;
  onLogout: () => void;
}) {
  const tr = useT();
  const kicker = tr.t('ui.claim.kicker');
  if (load.status === 'loading')
    return (
      <PageShell title={tr.t('ui.claim.kicker')}>
        <Loading label={tr.t('ui.claim.loading')} />
      </PageShell>
    );
  if (load.status !== 'ready') {
    const [title, body] =
      load.status === 'invalid'
        ? [tr.t('ui.claim.invalid_title'), tr.t('ui.claim.invalid_body')]
        : load.status === 'rate_limited'
          ? [tr.t('ui.claim.rate_title'), ownerErrorText(tr, load.error)]
          : [tr.t('ui.common.error_title'), ownerErrorText(tr, load.error)];
    return (
      <PageShell title={kicker}>
        <div className={`state-box pixel-box claim-state is-${load.status}`} role={load.status === 'invalid' ? undefined : 'alert'}>
          <PixelIcon icon={load.status === 'invalid' ? 'scroll' : 'skull'} tone={load.status === 'invalid' ? 'plain' : 'danger'} size={36} />
          <p className="state-title">{title}</p>
          <p className="muted">{body}</p>
          <div className="row-actions">
            {load.status === 'error' ? (
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                {tr.t('ui.common.retry')}
              </button>
            ) : null}
            <Link className="btn" to="/owner">
              {tr.t('ui.claim.to_owner')}
            </Link>
            <Link className="btn btn-ghost" to="/">
              {tr.t('ui.claim.to_map')}
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  const a = load.agent;
  const loginText = loginErrorText(tr, loginError);
  return (
    <PageShell title={tr.t('ui.claim.title', { name: a.name })} kicker={kicker}>
      <section className="claim pixel-box">
        <div className="claim-hero">
          <div className="sprite-stage sprite-stage-xl">{a.spriteHash ? <SpriteFrame hash={a.spriteHash} scale={6} /> : null}</div>
          <div className="claim-meta">
            <p className="claim-name">{a.name}</p>
            <p className="chips">
              <span className={`chip chip-class class-${a.cls}`}>{tr.name('class', a.cls)}</span>
              <span className="chip">{tr.t('ui.agent.level', { level: a.level })}</span>
            </p>
            {a.look ? <p className="agent-look">{a.look}</p> : null}
          </div>
        </div>
        <p className="claim-explain">{tr.t('ui.claim.explain', { max: MAX_AGENTS })}</p>

        {loginText ? (
          <p className="owner-error" role="alert">
            {loginText}
          </p>
        ) : null}

        {act.status === 'limit' ? (
          <div className="claim-limit" role="alert">
            <p className="state-title">{tr.t('ui.claim.limit_title', { max: MAX_AGENTS })}</p>
            <p className="small">{tr.t('ui.claim.limit_body')}</p>
            <Link className="btn" to="/owner">
              {tr.t('ui.claim.to_owner')}
            </Link>
          </div>
        ) : session === 'in' ? (
          <div className="claim-actions">
            <button type="button" className="btn btn-primary btn-big" disabled={act.status === 'working'} onClick={onClaim}>
              {act.status === 'working' ? tr.t('ui.claim.claiming') : tr.t('ui.claim.confirm', { name: a.name })}
            </button>
            <p className="small muted">
              {tr.t('ui.claim.signed_in_as', { name: ownerName ?? '' })}{' '}
              <button type="button" className="link-btn" disabled={busy} onClick={onLogout}>
                {tr.t('ui.claim.not_you')}
              </button>
            </p>
            {act.status === 'error' ? <ErrorLine error={act.error} /> : null}
          </div>
        ) : session === 'anon' ? (
          <div className="claim-actions">
            <p className="claim-sign-in">{tr.t('ui.claim.sign_in', { name: a.name })}</p>
            {providers ? (
              <LoginButtons providers={providers.providers} devLogin={providers.devLogin} next={`/claim/${token}`} demo={demo} busy={busy} onDevLogin={onDevLogin} />
            ) : (
              <Loading />
            )}
            <ErrorLine error={loginRequestError} />
          </div>
        ) : (
          <Loading />
        )}
      </section>
    </PageShell>
  );
}
