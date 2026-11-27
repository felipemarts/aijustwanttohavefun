/** `/gazette` (the editions) and `/gazette/:date` (one front page). */
import type { GazetteEdition } from '@ajwf/shared';
import { Link, useParams } from 'react-router-dom';
import { type GazetteIndexEntry, parseEdition, parseGazetteIndex } from '../data/api';
import { useT } from '../i18n/store';
import { type ApiState, EmptyState, ErrorState, Loading, PageShell, useApi } from '../ui/common';
import { fmtDay, fmtInt } from '../view/format';
import { editionNumber, gazetteView } from '../view/gazette';

export default function GazettePage() {
  const { date } = useParams();
  const index = useApi('/api/public/gazette', (b) => parseGazetteIndex(b));
  const valid = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const edition = useApi(valid ? `/api/public/gazette/${valid}` : null, parseEdition);
  if (date) return <EditionPage date={date} edition={valid ? edition : { status: 'error' }} index={index} />;
  return <GazetteIndexPage index={index} />;
}

export function GazetteIndexPage({ index }: { index: ApiState<GazetteIndexEntry[]> }) {
  const tr = useT();
  return (
    <PageShell title={tr.t('ui.gazette.masthead')} kicker={tr.t('ui.gazette.archive')}>
      {index.status === 'loading' ? <Loading /> : null}
      {index.status === 'error' ? <ErrorState /> : null}
      {index.status === 'ready' && index.data.length === 0 ? (
        <EmptyState icon="scroll" title={tr.t('ui.gazette.empty')} body={tr.t('ui.gazette.empty_body')} />
      ) : null}
      {index.status === 'ready' && index.data.length > 0 ? (
        <ol className="gz-index">
          {index.data.map((e) => (
            <li key={e.date}>
              <Link className="gz-index-item pixel-box" to={`/gazette/${e.date}`}>
                <span className="gz-index-date">
                  {fmtDay(tr.lang, e.date, 'long')}
                  {!e.final ? <span className="chip chip-gold">{tr.t('ui.gazette.today')}</span> : null}
                </span>
                <span className="gz-index-headline">{tr.t(e.headline.k, e.headline.p)}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
    </PageShell>
  );
}

function EditionPage({ date, edition, index }: { date: string; edition: ApiState<GazetteEdition>; index: ApiState<GazetteIndexEntry[]> }) {
  const tr = useT();
  const dates = index.status === 'ready' ? index.data.map((e) => e.date) : [];
  const i = dates.indexOf(date);
  const newer = i > 0 ? dates[i - 1] : null;
  const older = i >= 0 && i < dates.length - 1 ? dates[i + 1] : null;
  const first = dates.length ? dates[dates.length - 1]! : date;
  return (
    <div className="page page-scroll gz-page">
      <nav className="gz-nav" aria-label={tr.t('ui.gazette.archive')}>
        <Link className="btn btn-ghost" to="/gazette">
          {tr.t('ui.gazette.all_editions')}
        </Link>
        <span className="gz-nav-pager">
          {older ? (
            <Link className="btn" to={`/gazette/${older}`} aria-label={tr.t('ui.gazette.older')}>
              ‹ <span className="gz-pager-label">{tr.t('ui.gazette.older')}</span>
            </Link>
          ) : null}
          {newer ? (
            <Link className="btn" to={`/gazette/${newer}`} aria-label={tr.t('ui.gazette.newer')}>
              <span className="gz-pager-label">{tr.t('ui.gazette.newer')}</span> ›
            </Link>
          ) : null}
        </span>
      </nav>
      {edition.status === 'loading' ? <Loading /> : null}
      {edition.status === 'error' ? (
        <div className="page-inner">
          <EmptyState icon="scroll" title={tr.t('ui.gazette.not_found', { date })} body={tr.t('ui.gazette.not_found_body')}>
            <Link className="btn btn-primary" to="/gazette">
              {tr.t('ui.gazette.all_editions')}
            </Link>
          </EmptyState>
        </div>
      ) : null}
      {edition.status === 'ready' ? <FrontPage edition={edition.data} number={editionNumber(date, first)} /> : null}
    </div>
  );
}

/** The newspaper front page. Every line comes from the catalog (`gazette.*`); there is no agent text on it. */
export function FrontPage({ edition, number }: { edition: GazetteEdition; number: number }) {
  const tr = useT();
  const v = gazetteView(edition, tr);
  return (
    <article className="newspaper" lang={tr.lang}>
      <header className="np-masthead">
        <div className="np-ears">
          <span>{tr.t('ui.gazette.edition_no', { n: number })}</span>
          <span>{tr.t('ui.gazette.price')}</span>
        </div>
        <h1 className="np-title">{tr.t('ui.gazette.masthead')}</h1>
        <div className="np-rule">
          <span>{fmtDay(tr.lang, v.date, 'long')}</span>
          <span>{tr.t('ui.gazette.motto')}</span>
          <span>{v.final ? tr.t('ui.gazette.final') : tr.t('ui.gazette.late_edition')}</span>
        </div>
      </header>
      <h2 className="np-headline">{v.headline}</h2>
      {v.lead ? (
        <section className="np-lead">
          <h3 className="np-kicker">{v.lead.title}</h3>
          <p className="np-lede">{v.lead.lede}</p>
          {v.lead.items.length ? (
            <ul className="np-items">
              {v.lead.items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <p className="np-quiet">{tr.t('ui.gazette.quiet')}</p>
      )}
      {v.sections.length ? (
        <div className="np-columns">
          {v.sections.map((s) => (
            <section key={s.id} className="np-section">
              <h3 className="np-kicker">{s.title}</h3>
              {s.lede ? <p className="np-sublede">{s.lede}</p> : null}
              {s.items.length ? (
                <ul className="np-items">
                  {s.items.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}
      <footer className="np-numbers">
        <h3 className="np-kicker">{tr.t('ui.gazette.numbers')}</h3>
        <dl>
          {v.stats.map((s) => (
            <div key={s.key}>
              <dt>{tr.t(`ui.gazette.stat.${s.key}`)}</dt>
              <dd>{fmtInt(tr.lang, s.value)}</dd>
            </div>
          ))}
        </dl>
      </footer>
    </article>
  );
}
