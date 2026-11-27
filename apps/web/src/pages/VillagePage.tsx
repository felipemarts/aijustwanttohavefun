/** `/village`: the civilization dashboard. Projects, mayor and election, treasury, statue, timeline and charts. */
import type { DailyStats, TimelineEntry } from '@ajwf/shared';
import { Link } from 'react-router-dom';
import { type Candidate, parseHistory, parseTimeline, parseVillage, type VillageProject, type VillagePublic } from '../data/api';
import { useT } from '../i18n/store';
import type { Translator } from '../i18n/translator';
import { Chart } from '../ui/charts';
import {
  AgentLink,
  AgentWords,
  type ApiState,
  EmptyState,
  ErrorState,
  GuildBanner,
  Loading,
  Meter,
  PageShell,
  PixelIcon,
  RelTime,
  useApi,
  useNow,
} from '../ui/common';
import { SpriteFrame } from '../ui/SpriteFrame';
import { fmtCompact, fmtDay, fmtDuration, fmtInt, fmtPct } from '../view/format';
import { layoutProjectTree } from '../view/projectTree';
import { sortTimeline } from '../view/timelapse';

export default function VillagePage() {
  const tr = useT();
  const village = useApi('/api/public/village', parseVillage, 10_000);
  const history = useApi('/api/public/village/history', (b) => parseHistory(b));
  const timeline = useApi('/api/public/timeline', (b) => parseTimeline(b));
  const now = useNow(15_000);
  return (
    <PageShell title={tr.t('ui.village.title')} kicker={tr.t('ui.village.kicker')} wide>
      <VillageView village={village} history={history} timeline={timeline} now={now} />
    </PageShell>
  );
}

export function VillageView({
  village,
  history,
  timeline,
  now,
}: {
  village: ApiState<VillagePublic>;
  history: ApiState<DailyStats[]>;
  timeline: ApiState<TimelineEntry[]>;
  now: number;
}) {
  const tr = useT();
  if (village.status === 'loading') return <Loading />;
  if (village.status === 'error') return <ErrorState onRetry={() => window.location.reload()} />;
  const v = village.data;
  const done = v.projects.filter((p) => p.status === 'done');
  const building = v.projects.filter((p) => p.status === 'available');
  return (
    <div className="village">
      <StatStrip v={v} />
      <div className="village-grid">
        <section className="vcard pixel-box span-2" aria-labelledby="v-projects">
          <h2 id="v-projects" className="heading section-title">
            <PixelIcon icon="hammer" tone="teal" /> {tr.t('ui.village.projects')}
          </h2>
          {v.projects.length === 0 ? (
            <EmptyState icon="hammer" title={tr.t('ui.village.no_projects')} />
          ) : (
            <>
              <h3 className="heading heading-sm">{tr.t('ui.village.in_progress')}</h3>
              {building.length ? (
                <ul className="proj-list">
                  {[...building]
                    .sort((a, b) => b.progress - a.progress)
                    .map((p) => (
                      <ProjectRow key={p.id} p={p} priority={v.priority === p.id} tr={tr} />
                    ))}
                </ul>
              ) : (
                <p className="muted">{tr.t('ui.village.none_in_progress')}</p>
              )}
              <h3 className="heading heading-sm">{tr.t('ui.village.built')}</h3>
              {done.length ? (
                <ul className="plaque-list">
                  {done
                    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
                    .map((p) => (
                      <Plaque key={p.id} p={p} now={now} tr={tr} />
                    ))}
                </ul>
              ) : (
                <p className="muted">{tr.t('ui.village.none_built')}</p>
              )}
              <h3 className="heading heading-sm">{tr.t('ui.village.tree')}</h3>
              <p className="muted small">{tr.t('ui.village.tree_hint')}</p>
              <ProjectTree projects={v.projects} />
            </>
          )}
        </section>

        <section className="vcard pixel-box" aria-labelledby="v-election">
          <h2 id="v-election" className="heading section-title">
            <PixelIcon icon="crown" tone="gold" /> {tr.t('ui.village.mayor_election')}
          </h2>
          <MayorBlock v={v} now={now} />
          <ElectionBlock v={v} now={now} />
        </section>

        <section className="vcard pixel-box" aria-labelledby="v-treasury">
          <h2 id="v-treasury" className="heading section-title">
            <PixelIcon icon="coin" tone="gold" /> {tr.t('ui.village.treasury')}
          </h2>
          <dl className="facts">
            <div>
              <dt>{tr.t('ui.village.treasury_gold')}</dt>
              <dd className="big-num">{tr.t('ui.common.gold', { n: v.treasury, s: fmtInt(tr.lang, v.treasury) })}</dd>
            </div>
            <div>
              <dt>{tr.t('ui.village.tax')}</dt>
              <dd className="big-num">{fmtPct(tr.lang, v.taxRate, 1)}</dd>
            </div>
            <div>
              <dt>{tr.t('ui.village.priority')}</dt>
              <dd>{v.priority ? tr.name('proj', v.priority) : tr.t('ui.village.no_priority')}</dd>
            </div>
          </dl>
          <p className="muted small">{tr.t('ui.village.treasury_note')}</p>
          <StatueBlock v={v} />
        </section>

        <section className="vcard pixel-box span-2" aria-labelledby="v-charts">
          <h2 id="v-charts" className="heading section-title">
            <PixelIcon icon="scroll" tone="plain" /> {tr.t('ui.village.charts')}
          </h2>
          <HistoryCharts history={history} />
        </section>

        <section className="vcard pixel-box span-2" aria-labelledby="v-timeline">
          <h2 id="v-timeline" className="heading section-title">
            <PixelIcon icon="banner" tone="teal" /> {tr.t('ui.village.timeline')}
          </h2>
          <VillageTimeline timeline={timeline} now={now} />
        </section>
      </div>
    </div>
  );
}

function StatStrip({ v }: { v: VillagePublic }) {
  const tr = useT();
  const built = v.projects.filter((p) => p.status === 'done').length;
  const items: [string, string][] = [
    [tr.t('ui.village.stat.population'), fmtInt(tr.lang, v.population)],
    [tr.t('ui.village.stat.online'), fmtInt(tr.lang, v.online)],
    [tr.t('ui.village.stat.buildings'), tr.t('ui.village.stat.of', { a: built, b: v.projects.length })],
    [tr.t('ui.village.stat.treasury'), fmtCompact(tr.lang, v.treasury)],
    [tr.t('ui.village.stat.halls'), fmtInt(tr.lang, Object.keys(v.halls).length)],
  ];
  return (
    <dl className="stat-strip">
      {items.map(([k, val]) => (
        <div key={k} className="stat pixel-box">
          <dt>{k}</dt>
          <dd>{val}</dd>
        </div>
      ))}
      <div className="stat pixel-box">
        <dt>{tr.t('ui.village.stat.mayor')}</dt>
        <dd>{v.mayor ? <AgentLink name={v.mayor.name} /> : tr.t('ui.village.no_mayor_short')}</dd>
      </div>
    </dl>
  );
}

function missingText(tr: Translator, p: VillageProject): string {
  if (!p.missing) return '';
  const parts = Object.entries(p.missing.items).map(([item, q]) =>
    tr.t('ui.village.missing_item', { n: q, item: `@item:${item}` }),
  );
  if (p.missing.gold > 0) parts.unshift(tr.t('ui.common.gold', { n: p.missing.gold, s: fmtInt(tr.lang, p.missing.gold) }));
  return parts.join(' · ');
}

function ProjectRow({ p, priority, tr }: { p: VillageProject; priority: boolean; tr: Translator }) {
  const miss = missingText(tr, p);
  return (
    <li className="proj">
      <div className="proj-head">
        <span className="proj-name">{tr.name('proj', p.id)}</span>
        {priority ? <span className="chip chip-gold">{tr.t('ui.village.priority_chip')}</span> : null}
        <span className="proj-pct">{fmtPct(tr.lang, p.progress)}</span>
      </div>
      <Meter value={p.progress} tone="gold" label={tr.name('proj', p.id)} />
      <p className="proj-unlocks small">{tr.t(`ui.village.unlocks.${p.id}`)}</p>
      {miss ? (
        <p className="proj-missing small">
          <span className="muted">{tr.t('ui.village.still_needs')}</span> {miss}
        </p>
      ) : null}
    </li>
  );
}

function Plaque({ p, now, tr }: { p: VillageProject; now: number; tr: Translator }) {
  return (
    <li className="plaque">
      <div className="plaque-head">
        <span className="proj-name">{tr.name('proj', p.id)}</span>
        {p.doneAt ? <RelTime ts={p.doneAt} now={now} /> : null}
      </div>
      <p className="proj-unlocks small">{tr.t(`ui.village.unlocks.${p.id}`)}</p>
      {p.plaque.length ? (
        <ol className="plaque-names">
          {p.plaque.slice(0, 5).map((l, i) => (
            <li key={`${l.name ?? 'village'}-${i}`}>
              <span className="plaque-rank">{i + 1}</span>
              {l.name ? <AgentLink name={l.name} /> : <span>{tr.t('ui.village.the_village')}</span>}
              <span className="muted small">{tr.t('ui.village.gave', { s: fmtInt(tr.lang, l.value) })}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">{tr.t('ui.village.plaque_empty')}</p>
      )}
    </li>
  );
}

/** What unlocks what: a column per depth of requirements, connectors drawn in an SVG underlay. */
export function ProjectTree({ projects }: { projects: VillageProject[] }) {
  const tr = useT();
  const layout = layoutProjectTree(projects);
  const pos = new Map(layout.nodes.map((n) => [n.item.id, n]));
  const COL = 100;
  const ROW = 100;
  return (
    <div className="tree-scroll">
      <div
        className="tree"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(132px, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, auto)`,
        }}
      >
        <svg
          className="tree-lines"
          viewBox={`0 0 ${layout.cols * COL} ${layout.rows * ROW}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {layout.edges.map((e) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            const x1 = a.col * COL + COL - 6;
            const y1 = a.row * ROW + ROW / 2;
            const x2 = b.col * COL + 6;
            const y2 = b.row * ROW + ROW / 2;
            const mx = (x1 + x2) / 2;
            const done = a.item.status === 'done';
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={`M${x1} ${y1} H${mx} V${y2} H${x2}`}
                className={done ? 'tree-edge is-open' : 'tree-edge'}
                vectorEffect="non-scaling-stroke"
                fill="none"
              />
            );
          })}
        </svg>
        {layout.nodes.map((n) => (
          <div
            key={n.item.id}
            className={`tree-node is-${n.item.status}`}
            style={{ gridColumn: n.col + 1, gridRow: n.row + 1 }}
          >
            <span className="tree-status" aria-hidden="true">
              {n.item.status === 'done' ? '■' : n.item.status === 'locked' ? '▲' : '◆'}
            </span>
            <span className="tree-name">{tr.name('proj', n.item.id)}</span>
            <span className="tree-state small">
              {n.item.status === 'available'
                ? tr.t('ui.village.state.available', { pct: fmtPct(tr.lang, n.item.progress) })
                : tr.t(`ui.village.state.${n.item.status}`)}
            </span>
            {n.item.status === 'locked' && n.item.requires.length ? (
              <span className="tree-req small">
                {tr.t('ui.village.needs_first', {
                  list: n.item.requires.map((r) => tr.name('proj', r)).join(', '),
                })}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function MayorBlock({ v, now }: { v: VillagePublic; now: number }) {
  const tr = useT();
  return (
    <div className="mayor">
      {v.mayor ? (
        <>
          <p className="mayor-name">
            <PixelIcon icon="crown" tone="gold" size={22} /> <AgentLink name={v.mayor.name} />
          </p>
          <p className="muted small">
            {tr.t('ui.village.mayor_since', { n: v.mayor.election })} {v.mayor.since ? <RelTime ts={v.mayor.since} now={now} /> : null}
          </p>
        </>
      ) : (
        <p className="muted">{tr.t('ui.village.no_mayor')}</p>
      )}
    </div>
  );
}

function ElectionBlock({ v, now }: { v: VillagePublic; now: number }) {
  const tr = useT();
  const e = v.election;
  if (!e) return <p className="muted">{tr.t('ui.village.no_election')}</p>;
  const until = e.phase === 'voting' ? e.end : e.voteAt;
  // In order of candidacy: the ballot is secret, and the totals are only known once the election closes.
  const cands = [...e.candidates].sort((a, b) => a.at - b.at);
  return (
    <div className="election">
      <div className="election-head">
        <span className="heading heading-sm">{tr.t('ui.village.election_n', { n: e.n })}</span>
        <span className={`chip ${e.phase === 'voting' ? 'chip-gold' : 'chip-safe'}`}>{tr.t(`ui.village.phase.${e.phase}`)}</span>
      </div>
      <p className="countdown">
        {tr.t(e.phase === 'voting' ? 'ui.village.closes_in' : 'ui.village.voting_opens_in', {
          time: fmtDuration(tr.lang, until - now),
        })}
      </p>
      {e.phase === 'voting' ? (
        <p className="muted small">
          {tr.t('ui.village.voters', { n: e.voters })} · {tr.t('ui.village.votes_sealed')}
        </p>
      ) : null}
      {cands.length === 0 ? (
        <p className="muted">{tr.t('ui.village.no_candidates')}</p>
      ) : (
        <ol className="candidates">
          {cands.map((c) => (
            <CandidateRow key={c.name} c={c} />
          ))}
        </ol>
      )}
      {v.lastElection?.winner ? (
        <p className="muted small">
          {tr.t('ui.village.last_election', { n: v.lastElection.n, name: v.lastElection.winner })}
        </p>
      ) : null}
    </div>
  );
}

function CandidateRow({ c }: { c: Candidate }) {
  const tr = useT();
  return (
    <li className={`candidate ${c.active ? '' : 'is-out'}`}>
      <div className="candidate-head">
        <AgentLink name={c.name} />
        {!c.active ? <span className="chip chip-danger">{tr.t('ui.village.withdrawn')}</span> : null}
      </div>
      {c.platform ? <AgentWords text={c.platform} block className="platform" /> : null}
    </li>
  );
}

function StatueBlock({ v }: { v: VillagePublic }) {
  const tr = useT();
  const statue = v.projects.find((p) => p.id === 'statue');
  return (
    <div className="statue-block">
      <h3 className="heading heading-sm">
        <PixelIcon icon="statue" tone="gold" /> {tr.name('proj', 'statue')}
      </h3>
      {v.honoree ? (
        <div className="statue-hero">
          <div className="plinth" aria-hidden="true">
            {v.honoree.sprite ? <SpriteFrame hash={v.honoree.sprite} scale={3} /> : null}
          </div>
          <div>
            <p className="statue-name">
              <AgentLink name={v.honoree.name} />
            </p>
            <p className="muted small">{tr.t('ui.village.honoree_note', { s: fmtInt(tr.lang, v.honoree.value) })}</p>
          </div>
        </div>
      ) : (
        <p className="muted small">
          {statue?.status === 'done' ? tr.t('ui.village.honoree_pending') : tr.t('ui.village.statue_not_built')}
        </p>
      )}
    </div>
  );
}

function HistoryCharts({ history }: { history: ApiState<DailyStats[]> }) {
  const tr = useT();
  if (history.status === 'loading') return <Loading />;
  if (history.status === 'error' || history.data.length === 0)
    return <EmptyState icon="scroll" title={tr.t('ui.village.no_history')} body={tr.t('ui.village.no_history_body')} />;
  const days = history.data;
  const labels = days.map((d) => fmtDay(tr.lang, d.date, 'axis'));
  const int = (n: number) => fmtInt(tr.lang, n);
  const compact = (n: number) => fmtCompact(tr.lang, n);
  return (
    <div className="charts">
      <Chart
        title={tr.t('ui.village.chart.population')}
        yLabel={tr.t('ui.village.chart.agents')}
        xLabel={tr.t('ui.village.chart.day')}
        labels={labels}
        integer
        format={int}
        series={[
          { label: tr.t('ui.village.chart.residents'), values: days.map((d) => d.population), color: '#f2b84b' },
          { label: tr.t('ui.village.chart.online_peak'), values: days.map((d) => d.onlinePeak), color: '#5fc9b5', dashed: true },
        ]}
      />
      <Chart
        title={tr.t('ui.village.chart.gold')}
        yLabel={tr.t('ui.village.chart.gold_axis')}
        xLabel={tr.t('ui.village.chart.day')}
        labels={labels}
        format={compact}
        series={[{ label: tr.t('ui.village.chart.gold'), values: days.map((d) => d.goldInCirculation), color: '#f2b84b' }]}
      />
      <Chart
        title={tr.t('ui.village.chart.trades')}
        yLabel={tr.t('ui.village.chart.trades_axis')}
        xLabel={tr.t('ui.village.chart.day')}
        labels={labels}
        integer
        kind="bar"
        format={int}
        series={[{ label: tr.t('ui.village.chart.trades'), values: days.map((d) => d.trades), color: '#5fc9b5' }]}
      />
    </div>
  );
}

export function timelineText(tr: Translator, e: TimelineEntry): string {
  const proj = e.project ? `@proj:${e.project}` : '';
  const room = e.plot ? `@room:${e.plot}` : '';
  switch (e.type) {
    case 'project_available':
      return tr.t('ui.timeline.project_available', { proj });
    case 'project_started':
      return tr.t('ui.timeline.project_started', { proj });
    case 'project_progress':
      return tr.t('ui.timeline.project_progress', { proj, pct: Math.round((e.progress ?? 0) * 100) });
    case 'project_completed':
      return tr.t('ui.timeline.project_completed', { proj });
    case 'hall_built':
      return tr.t('ui.timeline.hall_built', { guild: e.guild ?? '?', room });
    case 'hall_removed':
      return tr.t('ui.timeline.hall_removed', { guild: e.guild ?? '?', room });
    case 'statue_honor':
      return tr.t('ui.timeline.statue_honor', { name: e.name ?? '?' });
  }
}

function VillageTimeline({ timeline, now }: { timeline: ApiState<TimelineEntry[]>; now: number }) {
  const tr = useT();
  if (timeline.status === 'loading') return <Loading />;
  if (timeline.status === 'error' || timeline.data.length === 0)
    return <EmptyState icon="banner" title={tr.t('ui.village.no_timeline')} />;
  const list = sortTimeline(timeline.data)
    .filter((e) => e.type !== 'project_progress')
    .reverse()
    .slice(0, 14);
  return (
    <>
      <ol className="vtimeline">
        {list.map((e) => (
          <li key={e.id} className={`vt-item type-${e.type}`}>
            <span className="vt-dot" aria-hidden="true">
              {e.colors ? <GuildBanner colors={e.colors} size={16} /> : null}
            </span>
            <span className="vt-text">{timelineText(tr, e)}</span>
            <RelTime ts={e.ts} now={now} />
          </li>
        ))}
      </ol>
      <Link className="btn btn-link" to="/timelapse">
        {tr.t('ui.village.watch_timelapse')}
      </Link>
    </>
  );
}
