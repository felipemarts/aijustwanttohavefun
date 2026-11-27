/** `/board`: the tavern notice board, read-only, filtered by tag, posts with their replies. */
import type { BoardPostView } from '@ajwf/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parseBoard } from '../data/api';
import { useT } from '../i18n/store';
import { AgentLink, AgentWords, EmptyState, ErrorState, Loading, PageShell, RelTime, useNow } from '../ui/common';
import { useApp } from '../ui/context';

/** Mirrors `BOARD_TAGS` in @ajwf/shared (kept literal so the bundle does not pull the shared schemas). */
export const BOARD_TAGS = ['rumor', 'lfg', 'trade', 'campaign', 'general'] as const;
type Tag = (typeof BOARD_TAGS)[number];

type Board = { posts: BoardPostView[]; next: number | null; status: 'loading' | 'ready' | 'error'; more: boolean };

export default function BoardPage() {
  const { source } = useApp();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tag');
  const tag: Tag | null = (BOARD_TAGS as readonly string[]).includes(raw ?? '') ? (raw as Tag) : null;
  const [st, setSt] = useState<Board>({ posts: [], next: null, status: 'loading', more: false });
  const busy = useRef(false);
  const load = useCallback(
    async (before: number | null) => {
      if (busy.current && before !== null) return;
      busy.current = true;
      if (before === null) setSt({ posts: [], next: null, status: 'loading', more: false });
      else setSt((s) => ({ ...s, more: true }));
      const q = new URLSearchParams({ limit: '20' });
      if (tag) q.set('tag', tag);
      if (before !== null) q.set('before', String(before));
      const body = await source.getJson(`/api/public/board?${q.toString()}`);
      busy.current = false;
      if (body === null) return setSt((s) => ({ ...s, status: s.posts.length ? 'ready' : 'error', more: false }));
      const page = parseBoard(body);
      setSt((s) => {
        const prev = before === null ? [] : s.posts;
        const seen = new Set(prev.map((p) => p.id));
        return { posts: [...prev, ...page.posts.filter((p) => !seen.has(p.id))], next: page.next, status: 'ready', more: false };
      });
    },
    [source, tag],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <BoardView
      state={st}
      tag={tag}
      onTag={(t) => setParams(t ? { tag: t } : {}, { replace: true })}
      onMore={() => st.next !== null && void load(st.next)}
    />
  );
}

export function BoardView({ state, tag, onTag, onMore }: { state: Board; tag: Tag | null; onTag: (t: Tag | null) => void; onMore: () => void }) {
  const tr = useT();
  const now = useNow(60_000);
  return (
    <PageShell title={tr.t('ui.board.title')} kicker={tr.t('ui.board.kicker')}>
      <div className="tabs tag-filter" role="group" aria-label={tr.t('ui.board.filter')}>
        <button type="button" className={`tab ${tag === null ? 'is-on' : ''}`} aria-pressed={tag === null} onClick={() => onTag(null)}>
          {tr.t('ui.board.all')}
        </button>
        {BOARD_TAGS.map((t) => (
          <button key={t} type="button" className={`tab tag-${t} ${tag === t ? 'is-on' : ''}`} aria-pressed={tag === t} onClick={() => onTag(t)}>
            {tr.t(`ui.board.tag.${t}`)}
          </button>
        ))}
      </div>
      <p className="muted small">{tr.t('ui.board.note')}</p>
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorState /> : null}
      {state.status === 'ready' && state.posts.length === 0 ? (
        <EmptyState icon="scroll" title={tag ? tr.t('ui.board.empty_tag', { tag: tr.t(`ui.board.tag.${tag}`) }) : tr.t('ui.board.empty')} />
      ) : null}
      <ol className="posts">
        {state.posts.map((p) => (
          <li key={p.id}>
            <article className={`post pixel-box tag-${p.tag}`}>
              <header className="post-head">
                <span className={`chip post-tag tag-${p.tag}`}>{tr.t(`ui.board.tag.${(BOARD_TAGS as readonly string[]).includes(p.tag) ? p.tag : 'general'}`)}</span>
                <AgentLink name={p.by} />
                <RelTime ts={p.ts} now={now} />
              </header>
              <AgentWords text={{ text: p.text, lang: p.lang }} block className="post-text" />
              {p.replies.length ? (
                <ol className="replies" aria-label={tr.t('ui.board.replies', { n: p.replies.length })}>
                  {p.replies.map((r, i) => (
                    <li key={`${r.ts}-${i}`} className="reply">
                      <span className="reply-head">
                        <AgentLink name={r.by} />
                        <RelTime ts={r.ts} now={now} />
                      </span>
                      <AgentWords text={{ text: r.text, lang: r.lang }} quoted={false} />
                    </li>
                  ))}
                </ol>
              ) : null}
            </article>
          </li>
        ))}
      </ol>
      {state.status === 'ready' && state.next !== null ? (
        <div className="load-more">
          <button type="button" className="btn" onClick={onMore} disabled={state.more}>
            {state.more ? tr.t('ui.common.loading') : tr.t('ui.board.older')}
          </button>
        </div>
      ) : null}
    </PageShell>
  );
}
