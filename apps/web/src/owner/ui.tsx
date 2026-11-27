/**
 * Building blocks of the owner pages. Every one renders from props only (the pages hold the state and the calls),
 * so each state can be rendered and checked with `react-dom/server`. Agent names, notes and looks are only ever
 * React text nodes.
 */
import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Translator } from '../i18n/translator';
import { useT } from '../i18n/store';
import { titleText } from '../ui/AgentCard';
import { PixelIcon, RelTime } from '../ui/common';
import { SpriteFrame } from '../ui/SpriteFrame';
import { fmtDuration } from '../view/format';
import { OwnerClient, type OwnerError } from './client';
import type { OwnerAgent, OwnerShare } from './parse';
import type { PushState } from './push';
import type { SummaryView } from './summaryView';

// ── errors ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One sentence for an owner API error, in the page's language (the server's text only as a last resort). */
export function ownerErrorText(tr: Translator, e: OwnerError): string {
  switch (e.code) {
    case 'NETWORK':
      return tr.t('ui.owner.error.network');
    case 'RATE_LIMITED':
      return e.retryAfter ? tr.t('ui.owner.error.rate_limited', { when: fmtDuration(tr.lang, Math.max(60_000, e.retryAfter * 1000)) }) : tr.t('ui.owner.error.rate_limited_short');
    case 'UNAUTHORIZED':
      return tr.t('ui.owner.error.unauthorized');
    case 'BAD_RESPONSE':
    case 'INTERNAL':
      return tr.t('ui.owner.error.generic');
    default:
      return e.message || tr.t('ui.owner.error.generic');
  }
}

export function ErrorLine({ error }: { error: OwnerError | null }) {
  const tr = useT();
  if (!error) return null;
  return (
    <p className="owner-error" role="alert">
      {ownerErrorText(tr, error)}
    </p>
  );
}

// ── login ───────────────────────────────────────────────────────────────────────────────────────────────────

const LOGIN_ERRORS = new Set(['denied', 'state', 'expired', 'provider']);

/** `?login_error=` from the OAuth callback, as a sentence (unknown values get the generic one). */
export function loginErrorText(tr: Translator, code: string | null): string | null {
  if (!code) return null;
  return tr.t(`ui.owner.login_error.${LOGIN_ERRORS.has(code) ? code : 'generic'}`);
}

/**
 * One button per configured provider: a full navigation to the server, which redirects to the provider and back to
 * `next`. Links never send a referrer (the claim page's URL holds its token).
 */
export function LoginButtons({
  providers,
  devLogin,
  next,
  demo,
  busy,
  onDevLogin,
}: {
  providers: readonly string[];
  devLogin: boolean;
  next: string;
  demo: boolean;
  busy: boolean;
  onDevLogin: () => void;
}) {
  const tr = useT();
  if (!providers.length && !devLogin) return <p className="muted">{tr.t('ui.owner.no_login')}</p>;
  return (
    <div className="login-buttons">
      {providers.map((p) =>
        demo ? (
          <button key={p} type="button" className="btn btn-primary" disabled={busy} onClick={onDevLogin}>
            <ProviderMark provider={p} /> {tr.t('ui.owner.sign_in_with', { provider: tr.t(`ui.owner.provider.${p}`) })}
          </button>
        ) : (
          <a key={p} className="btn btn-primary" href={OwnerClient.loginUrl(p, next)} rel="noreferrer" referrerPolicy="no-referrer">
            <ProviderMark provider={p} /> {tr.t('ui.owner.sign_in_with', { provider: tr.t(`ui.owner.provider.${p}`) })}
          </a>
        ),
      )}
      {devLogin ? (
        <button type="button" className="btn" disabled={busy} onClick={onDevLogin}>
          {tr.t('ui.owner.dev_login')}
        </button>
      ) : null}
    </div>
  );
}

/** A tiny pixel mark per provider (drawn here: no third-party logos or assets). */
function ProviderMark({ provider }: { provider: string }) {
  return (
    <svg viewBox="0 0 7 7" width="14" height="14" aria-hidden="true" shapeRendering="crispEdges" className="provider-mark">
      {provider === 'github' ? (
        <path d="M2 0h3v1h1v1h1v3H6v1H5v1H2V6H1V5H0V2h1V1h1zM2 2v2h3V2z" fill="currentColor" />
      ) : (
        <path d="M1 1h5v1H2v3h3V4H4V3h2v3H1z" fill="currentColor" />
      )}
    </svg>
  );
}

// ── agent cards ─────────────────────────────────────────────────────────────────────────────────────────────

const STATUS_CHIP: Record<OwnerAgent['status'], string> = { active: 'chip-safe', retired: '', banned: 'chip-danger' };

export function StatusChip({ status }: { status: OwnerAgent['status'] }) {
  const tr = useT();
  return <span className={`chip ${STATUS_CHIP[status]}`}>{tr.t(`ui.owner.status.${status}`)}</span>;
}

export function OwnerAgentCard({ agent, selected, now, onOpen }: { agent: OwnerAgent; selected: boolean; now: number; onOpen: () => void }) {
  const tr = useT();
  const title = titleText(tr, agent.title) ?? agent.titleText;
  return (
    <button type="button" className={`owner-card pixel-box ${selected ? 'is-on' : ''} ${agent.status !== 'active' ? 'is-inactive' : ''}`} aria-pressed={selected} onClick={onOpen}>
      <span className="sprite-stage owner-card-sprite">{agent.spriteHash ? <SpriteFrame hash={agent.spriteHash} scale={3} /> : null}</span>
      <span className="owner-card-body">
        <span className="owner-card-name">{agent.name}</span>
        {title ? <span className="owner-card-title">{title}</span> : null}
        <span className="chips">
          <span className={`chip chip-class class-${agent.cls}`}>{tr.name('class', agent.cls)}</span>
          <span className="chip">{tr.t('ui.agent.level', { level: agent.level })}</span>
          <StatusChip status={agent.status} />
        </span>
        <span className="owner-card-active small muted">
          {tr.t('ui.owner.last_active')} <RelTime ts={agent.lastActiveAt} now={now} />
        </span>
      </span>
    </button>
  );
}

// ── the letter ("while you were away") ─────────────────────────────────────────────────────────────────────

export type LetterState = { status: 'loading' } | { status: 'error'; error: OwnerError } | { status: 'ready'; view: SummaryView };

export function LetterView({ agent, ownerName, state, onRetry }: { agent: OwnerAgent; ownerName: string; state: LetterState; onRetry: () => void }) {
  const tr = useT();
  const titleId = useId();
  return (
    <section className="letter" aria-labelledby={titleId}>
      <header className="letter-head">
        <span className="letter-seal" aria-hidden="true">
          {agent.spriteHash ? <SpriteFrame hash={agent.spriteHash} scale={2} /> : null}
        </span>
        <div>
          <h2 id={titleId} className="letter-title">
            {tr.t('ui.owner.letter.title', { name: agent.name })}
          </h2>
          {state.status === 'ready' ? <p className="letter-window">{state.view.window}</p> : null}
        </div>
      </header>
      {state.status === 'loading' ? (
        <p className="letter-loading" role="status">
          {tr.t('ui.owner.letter.loading')}
        </p>
      ) : state.status === 'error' ? (
        <div className="letter-body" role="alert">
          <p>{ownerErrorText(tr, state.error)}</p>
          <button type="button" className="btn" onClick={onRetry}>
            {tr.t('ui.common.retry')}
          </button>
        </div>
      ) : (
        <div className="letter-body">
          <p className="letter-dear">{tr.t('ui.owner.letter.dear', { owner: ownerName })}</p>
          <ol className="story">
            {state.view.lines.map((l) => (
              <li key={l.key} className={`story-line type-${l.type}`}>
                <PixelIcon icon={l.icon} tone={l.tone} size={20} />
                <span>{l.text}</span>
              </li>
            ))}
          </ol>
          {state.view.highlights.length ? (
            <>
              <h3 className="letter-sub">{tr.t('ui.owner.letter.highlights')}</h3>
              <ul className="letter-highlights">
                {state.view.highlights.map((h) => (
                  <li key={h.id}>
                    <Link to={h.href}>{h.text}</Link> <RelTime ts={h.ts} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="letter-sign">{tr.t('ui.owner.letter.sign', { name: agent.name })}</p>
        </div>
      )}
    </section>
  );
}

// ── owner note ──────────────────────────────────────────────────────────────────────────────────────────────

/** Characters as the server counts them (code points). */
export const noteLength = (s: string) => [...s].length;

export function NoteEditorView({
  agentName,
  value,
  saved,
  max,
  saving,
  error,
  justSaved,
  onChange,
  onSave,
}: {
  agentName: string;
  value: string;
  /** The cleaned note the server stored: what the agent actually reads. */
  saved: string;
  max: number;
  saving: boolean;
  error: OwnerError | null;
  justSaved: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const tr = useT();
  const id = useId();
  const n = noteLength(value);
  const over = n > max;
  const changed = value !== saved;
  return (
    <section className="vcard pixel-box owner-note" aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`} className="heading section-title">
        <PixelIcon icon="scroll" tone="plain" /> {tr.t('ui.owner.note.title')}
      </h2>
      <p className="muted small">{tr.t('ui.owner.note.explain', { name: agentName })}</p>
      <label htmlFor={id} className="sr-only">
        {tr.t('ui.owner.note.title')}
      </label>
      <textarea
        id={id}
        className="owner-textarea"
        rows={3}
        value={value}
        placeholder={tr.t('ui.owner.note.placeholder')}
        aria-describedby={`${id}-c`}
        onChange={(e) => onChange(e.target.value)}
        spellCheck
      />
      <div className="note-foot">
        <span id={`${id}-c`} className={`note-count ${over ? 'is-over' : ''}`} aria-live="polite">
          {tr.t('ui.owner.note.count', { n, max })}
        </span>
        <button type="button" className="btn btn-primary" disabled={saving || over || !changed} onClick={onSave}>
          {saving ? tr.t('ui.owner.note.saving') : tr.t('ui.owner.note.save')}
        </button>
      </div>
      <ErrorLine error={error} />
      <div className="note-reads">
        <p className="small muted">{saved ? tr.t('ui.owner.note.reads', { name: agentName }) : tr.t('ui.owner.note.empty')}</p>
        {saved ? <blockquote className="agent-words is-block owner-note-saved">{saved}</blockquote> : null}
        {justSaved ? (
          <p className="small tone-ok" role="status">
            {saved ? tr.t('ui.owner.note.saved') : tr.t('ui.owner.note.cleared')}
          </p>
        ) : null}
      </div>
      <p className="small muted">{tr.t('ui.owner.note.cleaned')}</p>
    </section>
  );
}

// ── API key ─────────────────────────────────────────────────────────────────────────────────────────────────

export type KeyPhase = 'idle' | 'confirm' | 'working' | 'shown';

export function KeyPanelView({
  agent,
  phase,
  keyValue,
  copied,
  error,
  onAsk,
  onCancel,
  onConfirm,
  onCopy,
  onDone,
}: {
  agent: OwnerAgent;
  phase: KeyPhase;
  /** Only while `phase` is `shown`; it exists nowhere else on the page. */
  keyValue: string | null;
  copied: boolean;
  error: OwnerError | null;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onCopy: () => void;
  onDone: () => void;
}) {
  const tr = useT();
  const id = useId();
  const active = agent.status === 'active';
  return (
    <section className="vcard pixel-box owner-key" aria-labelledby={id}>
      <h2 id={id} className="heading section-title">
        <PixelIcon icon="coin" tone="gold" /> {tr.t('ui.owner.key.title')}
      </h2>
      <p className="muted small">{tr.t('ui.owner.key.explain', { name: agent.name })}</p>
      {!active ? <p className="small">{tr.t('ui.owner.key.inactive')}</p> : null}
      {active && phase === 'idle' ? (
        <button type="button" className="btn" onClick={onAsk}>
          {tr.t('ui.owner.key.button')}
        </button>
      ) : null}
      {active && (phase === 'confirm' || phase === 'working') ? (
        <div className="confirm-box" role="group" aria-label={tr.t('ui.owner.key.confirm_title')}>
          <p className="confirm-title">{tr.t('ui.owner.key.confirm_title')}</p>
          <p className="small">{tr.t('ui.owner.key.confirm_body', { name: agent.name })}</p>
          <div className="row-actions">
            <button type="button" className="btn btn-danger" disabled={phase === 'working'} onClick={onConfirm}>
              {phase === 'working' ? tr.t('ui.owner.key.working') : tr.t('ui.owner.key.confirm')}
            </button>
            <button type="button" className="btn btn-ghost" disabled={phase === 'working'} onClick={onCancel}>
              {tr.t('ui.owner.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      {phase === 'shown' && keyValue ? (
        <div className="key-shown">
          <p className="confirm-title">{tr.t('ui.owner.key.new_title')}</p>
          <p className="small">{tr.t('ui.owner.key.shown_once')}</p>
          <div className="sentence">
            <code className="key-value" translate="no">
              {keyValue}
            </code>
            <button type="button" className="btn btn-primary" onClick={onCopy}>
              {copied ? tr.t('ui.owner.copied') : tr.t('ui.owner.key.copy')}
            </button>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            {tr.t('ui.owner.key.done')}
          </button>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </section>
  );
}

// ── share ───────────────────────────────────────────────────────────────────────────────────────────────────

export function ShareView({
  agent,
  share,
  error,
  copied,
  demo,
  onCopy,
}: {
  agent: OwnerAgent;
  share: OwnerShare | null;
  error: OwnerError | null;
  copied: boolean;
  /** The demo has no card renderer: a stand-in card is drawn instead. */
  demo: boolean;
  onCopy: () => void;
}) {
  const tr = useT();
  const id = useId();
  const [broken, setBroken] = useState(false);
  const alt = tr.t('ui.owner.share.card_alt', { name: agent.name });
  return (
    <section className="vcard pixel-box owner-share" aria-labelledby={id}>
      <h2 id={id} className="heading section-title">
        <PixelIcon icon="banner" tone="teal" /> {tr.t('ui.owner.share.title')}
      </h2>
      {demo || broken ? (
        <div className="share-card share-card-stand-in" role="img" aria-label={alt}>
          <span className="sprite-stage">{agent.spriteHash ? <SpriteFrame hash={agent.spriteHash} scale={3} /> : null}</span>
          <span className="share-card-text">
            <span className="share-card-name">{agent.name}</span>
            <span className="small">{tr.t('ui.owner.share.level_class', { level: agent.level, class: tr.name('class', agent.cls) })}</span>
            <span className="small muted">{tr.t('ui.app_name')}</span>
          </span>
        </div>
      ) : (
        <img className="share-card" src={agent.cardPath} alt={alt} width={1200} height={630} loading="lazy" decoding="async" onError={() => setBroken(true)} />
      )}
      <div className="row-actions">
        <button type="button" className="btn" disabled={!share} onClick={onCopy}>
          {copied ? tr.t('ui.owner.share.copied') : tr.t('ui.owner.share.copy_link')}
        </button>
        {share ? (
          <a className="btn btn-primary" href={share.intentUrl} target="_blank" rel="noopener noreferrer">
            {tr.t('ui.owner.share.announce')}
          </a>
        ) : (
          <span className="btn btn-primary is-disabled" aria-disabled="true">
            {tr.t('ui.owner.share.announce')}
          </span>
        )}
      </div>
      <p className="small muted">{tr.t('ui.owner.share.announce_hint')}</p>
      <ErrorLine error={error} />
    </section>
  );
}

// ── typed confirmation ──────────────────────────────────────────────────────────────────────────────────────

/** Case- and width-insensitive match of what was typed against the word to type. */
export function typedMatches(typed: string, word: string): boolean {
  const norm = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase();
  return norm(typed) !== '' && norm(typed) === norm(word);
}

export function TypedConfirm({
  title,
  explain,
  word,
  openLabel,
  confirmLabel,
  working,
  error,
  onConfirm,
}: {
  title: string;
  explain: ReactNode;
  word: string;
  openLabel: string;
  confirmLabel: string;
  working: boolean;
  error: OwnerError | null;
  onConfirm: () => void;
}) {
  const tr = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <section className="danger-box" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="heading heading-sm danger-title">
        <PixelIcon icon="skull" tone="danger" /> {title}
      </h3>
      <p className="small">{explain}</p>
      {!open ? (
        <button type="button" className="btn btn-danger-ghost" onClick={() => setOpen(true)}>
          {openLabel}
        </button>
      ) : (
        <form
          className="typed-confirm"
          onSubmit={(e) => {
            e.preventDefault();
            if (typedMatches(typed, word) && !working) onConfirm();
          }}
        >
          <label htmlFor={id} className="small">
            {tr.t('ui.owner.type_to_confirm', { word })}
          </label>
          <input id={id} className="owner-input" value={typed} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
          <div className="row-actions">
            <button type="submit" className="btn btn-danger" disabled={!typedMatches(typed, word) || working}>
              {confirmLabel}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={working}
              onClick={() => {
                setOpen(false);
                setTyped('');
              }}
            >
              {tr.t('ui.owner.cancel')}
            </button>
          </div>
        </form>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

// ── notifications ───────────────────────────────────────────────────────────────────────────────────────────

export function PushView({ state, working, error, onEnable, onDisable }: { state: PushState | 'checking'; working: boolean; error: OwnerError | null; onEnable: () => void; onDisable: () => void }) {
  const tr = useT();
  const line =
    state === 'unsupported'
      ? tr.t('ui.owner.push.unsupported')
      : state === 'disabled'
        ? tr.t('ui.owner.push.disabled_server')
        : state === 'denied'
          ? tr.t('ui.owner.push.denied')
          : state === 'on'
            ? tr.t('ui.owner.push.on')
            : state === 'off'
              ? tr.t('ui.owner.push.off')
              : tr.t('ui.common.loading');
  const unavailable = state === 'unsupported' || state === 'disabled';
  return (
    <div className="push-box">
      <h3 className="heading heading-sm">
        <PixelIcon icon="star" tone="gold" /> {tr.t('ui.owner.push.title')}
      </h3>
      <p className="small muted">{tr.t('ui.owner.push.explain')}</p>
      {unavailable ? <p className="small chip-line">{tr.t('ui.owner.push.unavailable')}</p> : null}
      <p className="small" role="status">
        {line}
      </p>
      {state === 'off' || state === 'denied' ? (
        <button type="button" className="btn" disabled={working} onClick={onEnable}>
          {working ? tr.t('ui.owner.push.working') : tr.t('ui.owner.push.enable')}
        </button>
      ) : null}
      {state === 'on' ? (
        <button type="button" className="btn" disabled={working} onClick={onDisable}>
          {working ? tr.t('ui.owner.push.working') : tr.t('ui.owner.push.disable')}
        </button>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}

// ── how to add an agent ─────────────────────────────────────────────────────────────────────────────────────

export function AddAgentBox({ origin, full, max, copied, onCopy }: { origin: string; full: boolean; max: number; copied: boolean; onCopy: (text: string) => void }) {
  const tr = useT();
  const sentence = tr.t('ui.cta.sentence', { url: `${origin}/skill.md` });
  return (
    <section className="vcard pixel-box add-agent">
      <h2 className="heading section-title">
        <PixelIcon icon="heart" tone="teal" /> {tr.t('ui.owner.add.title')}
      </h2>
      {full ? <p className="small">{tr.t('ui.owner.add.full', { max })}</p> : <p className="small muted">{tr.t('ui.owner.add.body')}</p>}
      <div className="sentence">
        <code>{sentence}</code>
        <button type="button" className="btn btn-primary" onClick={() => onCopy(sentence)}>
          {copied ? tr.t('ui.owner.copied') : tr.t('ui.cta.copy')}
        </button>
      </div>
    </section>
  );
}

/** Copies text; returns false when the browser refused (the text stays selectable on the page). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
