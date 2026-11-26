import { Link } from 'react-router-dom';
import { config } from '../config';
import { useCounts, useStatus } from '../data/store';
import { ENDONYMS, isLang, LANGS } from '../i18n/languages';
import { i18n, useT } from '../i18n/store';
import { Cta } from './Cta';

const PHASE_ICON: Record<string, string> = { dawn: '◐', day: '☀', dusk: '◑', night: '☾' };

export function TopBar() {
  const tr = useT();
  const counts = useCounts();
  const status = useStatus();
  const population = counts.population ?? counts.agents;
  const online = counts.online ?? counts.agents;
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label={tr.t('ui.app_name')}>
        <img src="/favicon.svg" alt="" width={20} height={20} className="brand-mark" />
        <span className="brand-name">{tr.t('ui.app_name')}</span>
      </Link>
      <div className="counters" aria-live="polite">
        <span className={`live-dot ${status === 'live' ? 'is-live' : ''}`} aria-hidden="true" />
        {config.mock ? <span className="chip chip-demo">{tr.t('ui.status.mock')}</span> : null}
        <span className="counter counter-pop">{tr.t('ui.counters.population', { n: population })}</span>
        <span className="counter">{tr.t('ui.counters.online', { n: online })}</span>
        <span className="counter counter-phase" title={tr.t('ui.counters.phase')}>
          <span aria-hidden="true">{PHASE_ICON[counts.phase] ?? ''}</span> {tr.t(`ui.phase.${counts.phase}`)}
        </span>
      </div>
      <div className="topbar-actions">
        <label className="lang-select">
          <span className="sr-only">{tr.t('ui.lang.label')}</span>
          <select
            value={tr.lang}
            onChange={(e) => {
              if (isLang(e.target.value)) void i18n.setLang(e.target.value);
            }}
          >
            {LANGS.map((l) => (
              <option key={l} value={l} lang={l}>
                {ENDONYMS[l]}
              </option>
            ))}
          </select>
        </label>
        <Cta />
      </div>
    </header>
  );
}
