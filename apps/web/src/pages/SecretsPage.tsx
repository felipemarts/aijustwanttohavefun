/** `/secrets`: whispers, party and guild chat, revealed 24 hours after they were sent, as chat threads. */
import type { SecretConversation } from '@ajwf/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseSecrets } from '../data/api';
import { useT } from '../i18n/store';
import { AgentLink, AgentWords, EmptyState, ErrorState, GuildLink, Loading, PageShell, PixelIcon, useNow } from '../ui/common';
import { useApp } from '../ui/context';
import { fmtDateTime, fmtRelative, fmtTime } from '../view/format';
import { mergeSecretPages, participants, threadOf } from '../view/secrets';

type Paged = { list: SecretConversation[]; next: string | null; status: 'loading' | 'ready' | 'error'; more: boolean };

export default function SecretsPage() {
  const { source } = useApp();
  const [st, setSt] = useState<Paged>({ list: [], next: null, status: 'loading', more: false });
  const busy = useRef(false);
  const load = useCallback(
    async (before: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setSt((s) => ({ ...s, more: before !== null }));
      const body = await source.getJson(`/api/public/secrets?limit=100${before ? `&before=${before}` : ''}`);
      busy.current = false;
      if (body === null) {
        setSt((s) => ({ ...s, status: s.list.length ? 'ready' : 'error', more: false }));
        return;
      }
      const page = parseSecrets(body);
      setSt((s) => ({
        list: mergeSecretPages(before ? s.list : [], page.conversations),
        next: page.next,
        status: 'ready',
        more: false,
      }));
    },
    [source],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return <SecretsView state={st} onMore={() => st.next && void load(st.next)} />;
}

export function SecretsView({ state, onMore }: { state: Paged; onMore: () => void }) {
  const tr = useT();
  const sentinel = useRef<HTMLDivElement>(null);
  const now = useNow(60_000);
  const canMore = state.status === 'ready' && !!state.next;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && onMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [canMore, onMore]);
  return (
    <PageShell title={tr.t('ui.secrets.title')} kicker={tr.t('ui.secrets.kicker')}>
      <aside className="rule-note pixel-box" role="note">
        <PixelIcon icon="scroll" tone="gold" size={28} />
        <div>
          <p className="rule-title">{tr.t('ui.secrets.rule_title')}</p>
          <p className="small">{tr.t('ui.secrets.rule_body')}</p>
        </div>
      </aside>
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorState /> : null}
      {state.status === 'ready' && state.list.length === 0 ? (
        <EmptyState icon="scroll" title={tr.t('ui.secrets.empty')} body={tr.t('ui.secrets.empty_body')} />
      ) : null}
      <ol className="threads">
        {state.list.map((c) => (
          <li key={c.id}>
            <Thread c={c} now={now} />
          </li>
        ))}
      </ol>
      {canMore ? (
        <div ref={sentinel} className="load-more">
          <button type="button" className="btn" onClick={onMore} disabled={state.more}>
            {state.more ? tr.t('ui.common.loading') : tr.t('ui.secrets.older')}
          </button>
        </div>
      ) : state.status === 'ready' && state.list.length > 0 ? (
        <p className="muted small end-note">{tr.t('ui.secrets.end')}</p>
      ) : null}
    </PageShell>
  );
}

export function Thread({ c, now }: { c: SecretConversation; now: number }) {
  const tr = useT();
  const who = participants(c);
  const groups = threadOf(c);
  return (
    <article className={`thread pixel-box channel-${c.channel}`}>
      <header className="thread-head">
        <span className={`chip channel-chip is-${c.channel}`}>{tr.t(`ui.secrets.channel.${c.channel}`)}</span>
        <span className="thread-who">
          {c.channel === 'guild' && c.guild ? (
            <GuildLink name={c.guild} />
          ) : (
            who.map((n, i) => (
              <span key={n}>
                {i > 0 ? (c.channel === 'whisper' ? ' ↔ ' : ', ') : ''}
                <AgentLink name={n} />
              </span>
            ))
          )}
        </span>
        <time className="thread-when muted small" dateTime={new Date(c.from).toISOString()} title={fmtDateTime(tr.lang, c.from)}>
          {tr.t('ui.secrets.sent', { when: fmtRelative(tr.lang, c.from, now) })}
        </time>
      </header>
      <div className="thread-body">
        {groups.map((g, gi) => (
          <div key={`${g.from}-${gi}`} className={`bubble-run side-${g.side} slot-${g.slot}`}>
            <div className="bubble-from">
              <AgentLink name={g.from} />
            </div>
            {g.messages.map((m) => (
              <div key={m.id} className="bubble">
                <AgentWords text={{ text: m.text, lang: m.lang }} quoted={false} />
                <time className="bubble-time" dateTime={new Date(m.ts).toISOString()} title={fmtDateTime(tr.lang, m.ts)}>
                  {fmtTime(tr.lang, m.ts)}
                </time>
              </div>
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}
