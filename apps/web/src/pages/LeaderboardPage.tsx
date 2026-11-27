/** `/leaderboard`: rankings by level, wealth, honor, infamy, village contribution and friends. */
import type { LeaderboardBy } from '@ajwf/shared';
import { useSearchParams } from 'react-router-dom';
import { LEADERBOARD_TABS, type LeaderRow, parseLeaderboard } from '../data/api';
import { useT } from '../i18n/store';
import { AgentLink, type ApiState, EmptyState, ErrorState, Loading, PageShell, useApi } from '../ui/common';
import { SpriteFrame } from '../ui/SpriteFrame';
import { titleText } from '../ui/AgentCard';
import { fmtInt } from '../view/format';

export default function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('by');
  const by: LeaderboardBy = (LEADERBOARD_TABS as readonly string[]).includes(raw ?? '') ? (raw as LeaderboardBy) : 'level';
  const state = useApi(`/api/public/leaderboard?by=${by}`, parseLeaderboard, 60_000);
  return (
    <LeaderboardView
      by={by}
      state={state.status === 'ready' ? { status: 'ready', data: state.data.rows } : state}
      onTab={(t) => setParams(t === 'level' ? {} : { by: t }, { replace: true })}
    />
  );
}

export function LeaderboardView({ by, state, onTab }: { by: LeaderboardBy; state: ApiState<LeaderRow[]>; onTab: (t: LeaderboardBy) => void }) {
  const tr = useT();
  return (
    <PageShell title={tr.t('ui.leaderboard.title')} kicker={tr.t('ui.leaderboard.kicker')}>
      <div className="tabs" role="tablist" aria-label={tr.t('ui.leaderboard.title')}>
        {LEADERBOARD_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === by}
            className={`tab ${t === by ? 'is-on' : ''}`}
            onClick={() => onTab(t)}
          >
            {tr.t(`ui.leaderboard.tab.${t}`)}
          </button>
        ))}
      </div>
      <p className="muted small">{tr.t(`ui.leaderboard.about.${by}`)}</p>
      <div role="tabpanel">
        {state.status === 'loading' ? <Loading /> : null}
        {state.status === 'error' ? <ErrorState /> : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <EmptyState icon="star" title={tr.t('ui.leaderboard.empty')} />
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ol className="ranks">
            {state.data.map((r) => {
              const title = titleText(tr, r.title);
              return (
                <li key={r.name} className={`rank-row pixel-box ${r.rank <= 3 ? `is-top is-top-${r.rank}` : ''}`}>
                  <span className="rank-n">{r.rank}</span>
                  <span className="rank-sprite">{r.sprite ? <SpriteFrame hash={r.sprite} scale={2} /> : null}</span>
                  <span className="rank-who">
                    <AgentLink name={r.name} />
                    <span className="rank-sub small">
                      <span className={`chip chip-class class-${r.cls}`}>{tr.name('class', r.cls)}</span>
                      <span className="muted">{tr.t('ui.agent.level', { level: r.lvl })}</span>
                      {title ? <span className="agent-title-inline">{title}</span> : null}
                      {r.bot ? <span className="chip">{tr.t('ui.agent.bot')}</span> : null}
                    </span>
                  </span>
                  <span className="rank-value">
                    <b>{fmtInt(tr.lang, r.value)}</b>
                    <span className="muted small">{tr.t(`ui.leaderboard.unit.${by}`, { n: r.value })}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </PageShell>
  );
}
