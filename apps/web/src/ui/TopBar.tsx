import { useEffect, useId, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { config } from '../config';
import { useCounts, useStatus } from '../data/store';
import { ENDONYMS, isLang, type Lang, LANGS } from '../i18n/languages';
import { i18n, useT } from '../i18n/store';
import { Cta } from './Cta';
import { NAV } from './routes';

const PHASE_ICON: Record<string, string> = { dawn: '◐', day: '☀', dusk: '◑', night: '☾' };
/** Short labels for the closed selector on small screens (language data, the same in every locale). */
const SHORT: Record<Lang, string> = { en: 'EN', 'pt-BR': 'PT', es: 'ES', 'zh-CN': '中文', ja: '日本', fr: 'FR' };

export function TopBar() {
  const tr = useT();
  const counts = useCounts();
  const status = useStatus();
  const population = counts.population ?? counts.agents;
  const online = counts.online ?? counts.agents;
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const menuId = useId();
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);
  const onMap = loc.pathname === '/';
  return (
    <header className={`topbar ${onMap ? 'is-map' : ''}`}>
      <Link to="/" className="brand" aria-label={tr.t('ui.app_name')}>
        <img src="/favicon.svg" alt="" width={20} height={20} className="brand-mark" />
        <span className="brand-name">{tr.t('ui.app_name')}</span>
      </Link>
      <nav className="topnav" aria-label={tr.t('ui.nav.label')}>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `topnav-link ${isActive ? 'is-active' : ''}`}>
            {tr.t(`ui.nav.${n.key}`)}
          </NavLink>
        ))}
      </nav>
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
        <button
          type="button"
          className="btn btn-icon menu-btn"
          aria-expanded={menu}
          aria-controls={menuId}
          aria-label={tr.t('ui.nav.menu')}
          onClick={() => setMenu((m) => !m)}
        >
          <svg viewBox="0 0 10 10" width="18" height="18" aria-hidden="true" shapeRendering="crispEdges">
            <rect x="1" y="2" width="8" height="1.5" fill="currentColor" />
            <rect x="1" y="4.5" width="8" height="1.5" fill="currentColor" />
            <rect x="1" y="7" width="8" height="1.5" fill="currentColor" />
          </svg>
        </button>
        <label className="lang-select">
          <span className="lang-face" aria-hidden="true">
            <svg viewBox="0 0 9 9" width="14" height="14" shapeRendering="crispEdges">
              <rect x="2" y="0" width="5" height="1" fill="currentColor" />
              <rect x="1" y="1" width="1" height="1" fill="currentColor" />
              <rect x="7" y="1" width="1" height="1" fill="currentColor" />
              <rect x="0" y="2" width="1" height="5" fill="currentColor" />
              <rect x="8" y="2" width="1" height="5" fill="currentColor" />
              <rect x="4" y="1" width="1" height="7" fill="currentColor" />
              <rect x="1" y="4" width="7" height="1" fill="currentColor" />
              <rect x="1" y="7" width="1" height="1" fill="currentColor" />
              <rect x="7" y="7" width="1" height="1" fill="currentColor" />
              <rect x="2" y="8" width="5" height="1" fill="currentColor" />
            </svg>
            <span className="lang-long">{ENDONYMS[tr.lang as Lang] ?? tr.lang}</span>
            <span className="lang-short">{SHORT[tr.lang as Lang] ?? tr.lang}</span>
            <span className="lang-caret">▾</span>
          </span>
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
      {menu ? (
        <div className="drawer-scrim" onClick={() => setMenu(false)}>
          <nav id={menuId} className="drawer pixel-box" aria-label={tr.t('ui.nav.label')} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" aria-hidden="true" />
            <p className="drawer-title heading">{tr.t('ui.nav.title')}</p>
            <ul className="drawer-links">
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => `drawer-link ${isActive ? 'is-active' : ''}`}>
                    <span className="drawer-link-name">{tr.t(`ui.nav.${n.key}`)}</span>
                    <span className="drawer-link-hint small">{tr.t(`ui.nav.hint.${n.key}`)}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
            <p className="drawer-counts muted small">
              {tr.t('ui.counters.population', { n: population })} · {tr.t('ui.counters.online', { n: online })}
            </p>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
