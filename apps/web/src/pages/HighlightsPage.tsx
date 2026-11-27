/** `/highlights` (the feed) and `/h/:id` (one highlight). */
import type { Highlight } from '@ajwf/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { parseHighlightOne, parseHighlightPage } from '../data/api';
import { useT } from '../i18n/store';
import {
  AgentLink,
  AgentWords,
  type ApiState,
  EmptyState,
  ErrorState,
  GuildLink,
  Loading,
  PageShell,
  PixelIcon,
  RelTime,
  useApi,
  useNow,
} from '../ui/common';
import { useApp } from '../ui/context';
import { fmtDateTime } from '../view/format';
import { highlightView } from '../view/highlights';

const HID = /^h\d{1,15}(-\d+)?$/;

export default function HighlightsPage() {
  const { id } = useParams();
  if (id !== undefined) return <HighlightOnePage id={id} />;
  return <HighlightFeed />;
}

type Feed = { list: Highlight[]; next: string | null; status: 'loading' | 'ready' | 'error'; more: boolean };

function HighlightFeed() {
  const { source } = useApp();
  const [st, setSt] = useState<Feed>({ list: [], next: null, status: 'loading', more: false });
  const busy = useRef(false);
  const load = useCallback(
    async (before: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setSt((s) => ({ ...s, more: !!before }));
      const body = await source.getJson(`/api/public/highlights?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      busy.current = false;
      if (body === null) return setSt((s) => ({ ...s, status: s.list.length ? 'ready' : 'error', more: false }));
      const page = parseHighlightPage(body);
      setSt((s) => {
        const seen = new Set((before ? s.list : []).map((h) => h.id));
        return {
          list: [...(before ? s.list : []), ...page.highlights.filter((h) => !seen.has(h.id))],
          next: page.next,
          status: 'ready',
          more: false,
        };
      });
    },
    [source],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return <HighlightFeedView state={st} onMore={() => st.next && void load(st.next)} />;
}

export function HighlightFeedView({ state, onMore }: { state: Feed; onMore: () => void }) {
  const tr = useT();
  const now = useNow(30_000);
  return (
    <PageShell title={tr.t('ui.highlights.title')} kicker={tr.t('ui.highlights.kicker')}>
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorState /> : null}
      {state.status === 'ready' && state.list.length === 0 ? (
        <EmptyState icon="star" title={tr.t('ui.highlights.empty')} body={tr.t('ui.highlights.empty_body')} />
      ) : null}
      <ol className="hl-feed">
        {state.list.map((h) => (
          <li key={h.id}>
            <HighlightCard h={h} now={now} />
          </li>
        ))}
      </ol>
      {state.status === 'ready' && state.next ? (
        <div className="load-more">
          <button type="button" className="btn" onClick={onMore} disabled={state.more}>
            {state.more ? tr.t('ui.common.loading') : tr.t('ui.highlights.older')}
          </button>
        </div>
      ) : null}
    </PageShell>
  );
}

export function HighlightCard({ h, now, big = false }: { h: Highlight; now: number; big?: boolean }) {
  const tr = useT();
  const v = highlightView(h, tr);
  const Title = big ? 'h1' : 'h2';
  return (
    <article className={`hl-card pixel-box tone-${v.tone} ${big ? 'is-big' : ''}`}>
      <div className="hl-icon">
        <PixelIcon icon={v.icon} tone={v.tone} size={big ? 44 : 30} />
      </div>
      <div className="hl-main">
        <Title className={`hl-title ${big ? 'heading' : ''}`}>
          {big ? v.title : <Link to={`/h/${encodeURIComponent(v.id)}`}>{v.title}</Link>}
        </Title>
        {v.quote ? <AgentWords text={v.quote} block className="hl-quote" /> : null}
        <p className="hl-meta small">
          {v.agents.length ? (
            <span className="hl-agents">
              {v.agents.map((n, i) => (
                <span key={n}>
                  {i > 0 ? ' · ' : ''}
                  <AgentLink name={n} />
                </span>
              ))}
            </span>
          ) : null}
          {v.guild ? (
            <span>
              <GuildLink name={v.guild} />
            </span>
          ) : null}
          {v.room ? <span className="muted">{tr.t('ui.highlights.in_room', { room: `@room:${v.room}` })}</span> : null}
          <RelTime ts={v.ts} now={now} />
        </p>
      </div>
    </article>
  );
}

function HighlightOnePage({ id }: { id: string }) {
  const valid = HID.test(id);
  const state = useApi(valid ? `/api/public/highlights/${encodeURIComponent(id)}` : null, parseHighlightOne);
  return <HighlightOneView state={valid ? state : { status: 'error' }} />;
}

export function HighlightOneView({ state }: { state: ApiState<Highlight> }) {
  const tr = useT();
  const now = useNow(30_000);
  return (
    <PageShell title={tr.t('ui.highlights.one_title')} kicker={tr.t('ui.highlights.kicker')}>
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? (
        <EmptyState icon="star" title={tr.t('ui.highlights.not_found')}>
          <Link className="btn btn-primary" to="/highlights">
            {tr.t('ui.highlights.all')}
          </Link>
        </EmptyState>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <HighlightCard h={state.data} now={now} big />
          <p className="muted small">{fmtDateTime(tr.lang, state.data.ts)}</p>
          <div className="row-actions">
            {state.data.room ? (
              <Link className="btn" to={`/?room=${encodeURIComponent(state.data.room)}`}>
                {tr.t('ui.highlights.show_on_map')}
              </Link>
            ) : null}
            <Link className="btn btn-link" to="/highlights">
              {tr.t('ui.highlights.all')}
            </Link>
          </div>
        </>
      ) : null}
    </PageShell>
  );
}
