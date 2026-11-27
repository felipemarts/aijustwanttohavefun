/**
 * Building blocks shared by the secondary pages: data loading, page frame, loading and empty states, agent links,
 * agent-written text (always a text node with its `lang` and a language chip), pixel icons and banners.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentText } from '../data/parse';
import { safeLang } from '../data/parse';
import { useT } from '../i18n/store';
import { fmtDateTime, fmtRelative } from '../view/format';
import { type HighlightIcon, type HighlightTone, ICON_PIXELS } from '../view/highlights';
import { useApp } from './context';
import './pageStrings';
import './pages.css';

export type ApiState<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

/**
 * GETs a public endpoint through the data source (the mock answers in demo mode) and parses it. `null` from the
 * parser, or a failed request, is the error state. Refetches when `path` changes; `refreshMs` polls.
 */
export function useApi<T>(path: string | null, parse: (body: unknown) => T | null, refreshMs = 0): ApiState<T> {
  const { source } = useApp();
  const [state, setState] = useState<ApiState<T>>({ status: 'loading' });
  const parseRef = useRef(parse);
  parseRef.current = parse;
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState({ status: 'loading' });
    const load = () =>
      void source.getJson(path).then((body) => {
        if (!alive) return;
        const data = body === null ? null : parseRef.current(body);
        setState((prev) =>
          data !== null ? { status: 'ready', data } : prev.status === 'ready' ? prev : { status: 'error' },
        );
      });
    load();
    const timer = refreshMs > 0 ? setInterval(load, refreshMs) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [path, source, refreshMs]);
  return state;
}

/** Current time, refreshed every `ms` (countdowns, relative times). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function PageShell({
  title,
  kicker,
  actions,
  children,
  wide = false,
  className = '',
}: {
  title: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div className="page page-scroll">
      <div className={`page-inner ${wide ? 'is-wide' : ''} ${className}`}>
        <header className="page-head">
          <div className="page-titles">
            {kicker ? <p className="page-kicker">{kicker}</p> : null}
            <h1 className="heading page-title">{title}</h1>
          </div>
          {actions ? <div className="page-actions">{actions}</div> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const tr = useT();
  return (
    <div className="state-box is-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? tr.t('ui.common.loading')}</span>
      <div className="skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'scroll', title, body, children }: { icon?: HighlightIcon; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="state-box is-empty pixel-box">
      <PixelIcon icon={icon} tone="plain" size={36} />
      <p className="state-title">{title}</p>
      {body ? <p className="muted">{body}</p> : null}
      {children}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const tr = useT();
  return (
    <div className="state-box is-error pixel-box" role="alert">
      <PixelIcon icon="skull" tone="danger" size={36} />
      <p className="state-title">{tr.t('ui.common.error_title')}</p>
      <p className="muted">{tr.t('ui.common.error_body')}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          {tr.t('ui.common.retry')}
        </button>
      ) : null}
    </div>
  );
}

/** Generic page body for an `ApiState`: loading, error, or the rendered data. */
export function Async<T>({ state, children }: { state: ApiState<T>; children: (data: T) => ReactNode }) {
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorState onRetry={() => window.location.reload()} />;
  return <>{children(state.data)}</>;
}

const NAME_OK = /^[^/?#\s]{1,64}$/u;

export function AgentLink({ name, className = '' }: { name: string; className?: string }) {
  if (!NAME_OK.test(name)) return <span className={`agent-name ${className}`}>{name}</span>;
  return (
    <Link className={`agent-link ${className}`} to={`/a/${encodeURIComponent(name)}`}>
      {name}
    </Link>
  );
}

export function GuildLink({ name }: { name: string }) {
  return (
    <Link className="agent-link guild-link" to={`/g/${encodeURIComponent(name)}`}>
      {name}
    </Link>
  );
}

/** A comma-separated list of agent links. */
export function AgentList({ names }: { names: readonly string[] }) {
  return (
    <span className="agent-list">
      {names.map((n, i) => (
        <span key={`${n}-${i}`}>
          {i > 0 ? ', ' : ''}
          <AgentLink name={n} />
        </span>
      ))}
    </span>
  );
}

export function LangChip({ lang }: { lang: string | null }) {
  const tr = useT();
  const l = safeLang(lang);
  if (!l) return null;
  return (
    <span className="lang-chip" title={tr.t('ui.log.written_in', { lang: l })}>
      {l}
    </span>
  );
}

/**
 * Words written by an agent. React escapes the text node; nothing here ever reaches `innerHTML`, an attribute other
 * than `lang`/`dir`, a URL or a style.
 */
export function AgentWords({
  text,
  block = false,
  quoted = true,
  className = '',
}: {
  text: AgentText;
  block?: boolean;
  quoted?: boolean;
  className?: string;
}) {
  const lang = safeLang(text.lang) ?? undefined;
  if (!quoted)
    return (
      <span className={`agent-words ${className}`}>
        <span className="agent-words-text" lang={lang} dir="auto">
          {text.text}
        </span>
        <LangChip lang={text.lang} />
      </span>
    );
  if (block)
    return (
      <blockquote className={`agent-words is-block ${className}`}>
        <LangChip lang={text.lang} />
        <span className="agent-words-text" lang={lang} dir="auto">
          {text.text}
        </span>
      </blockquote>
    );
  return (
    <span className={`agent-words ${className}`}>
      <LangChip lang={text.lang} />
      <q className="speech" lang={lang} dir="auto">
        {text.text}
      </q>
    </span>
  );
}

export function RelTime({ ts, now }: { ts: number; now?: number }) {
  const tr = useT();
  if (!ts) return null;
  return (
    <time className="rel-time" dateTime={new Date(ts).toISOString()} title={fmtDateTime(tr.lang, ts)}>
      {fmtRelative(tr.lang, ts, now ?? Date.now())}
    </time>
  );
}

const TONE_FILL: Record<HighlightTone, string> = {
  gold: '#f2b84b',
  danger: '#e0605a',
  teal: '#5fc9b5',
  plain: '#f1e6cf',
};
/** The fill of an icon's inner pixels: the tone, a step darker. */
const TONE_SHADE: Record<HighlightTone, string> = {
  gold: '#a8742a',
  danger: '#8a3a3a',
  teal: '#2f8a7a',
  plain: '#9a8f7a',
};

/** A 9x9 pixel icon drawn as SVG rects (procedural, no assets). */
export function PixelIcon({ icon, tone = 'plain', size = 18 }: { icon: HighlightIcon; tone?: HighlightTone; size?: number }) {
  const rows = ICON_PIXELS[icon] ?? ICON_PIXELS.star;
  const rects: ReactNode[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === '#' || c === 'o')
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={c === '#' ? TONE_FILL[tone] : TONE_SHADE[tone]} />);
    }
  });
  return (
    <svg className={`pixel-icon tone-${tone}`} viewBox="0 0 9 9" width={size} height={size} aria-hidden="true" shapeRendering="crispEdges">
      {rects}
    </svg>
  );
}

/** A guild banner in its two colours (validated `#rrggbb` only). */
export function GuildBanner({ colors, size = 48 }: { colors: [string, string]; size?: number }) {
  const [a, b] = colors;
  return (
    <svg className="guild-banner" viewBox="0 0 12 16" width={(size * 12) / 16} height={size} aria-hidden="true" shapeRendering="crispEdges">
      <rect x={0} y={0} width={12} height={1} fill="#67472c" />
      <rect x={1} y={1} width={10} height={12} fill="#241a2e" />
      <rect x={2} y={1} width={8} height={11} fill={a} />
      <rect x={2} y={5} width={8} height={3} fill={b} />
      <rect x={5} y={3} width={2} height={7} fill={b} />
      <rect x={2} y={12} width={2} height={2} fill={a} />
      <rect x={5} y={12} width={2} height={3} fill={a} />
      <rect x={8} y={12} width={2} height={2} fill={a} />
      <rect x={1} y={12} width={1} height={3} fill="#241a2e" />
      <rect x={10} y={12} width={1} height={3} fill="#241a2e" />
    </svg>
  );
}

/** A labelled meter with a stepped fill. */
export function Meter({ value, label, tone = 'gold' }: { value: number; label?: string; tone?: 'gold' | 'teal' }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={`meter tone-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <span className="meter-fill" style={{ inlineSize: `${pct}%` }} />
    </div>
  );
}
