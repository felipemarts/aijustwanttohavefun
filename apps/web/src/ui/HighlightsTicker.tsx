import { Link, useNavigate } from 'react-router-dom';
import { useHighlights } from '../data/store';
import { useT } from '../i18n/store';
import { controller } from '../map/controller';
import { highlightView } from '../view/highlights';

/** A slow ticker of the world's highlights, pushed live in `world` batches. A click shows the place on the map. */
export function HighlightsTicker() {
  const tr = useT();
  const navigate = useNavigate();
  const all = useHighlights();
  const lines = all
    .slice(-8)
    .reverse()
    .map((h) => highlightView(h, tr));
  // Duration grows with content so the reading speed stays the same.
  const chars = lines.reduce((n, l) => n + l.title.length, 0);
  const dur = Math.max(30, Math.round(chars / 5));
  return (
    <aside className="ticker" aria-label={tr.t('ui.ticker.label')}>
      <Link className="ticker-label" to="/highlights" title={tr.t('ui.ticker.all')}>
        {tr.t('ui.ticker.label')}
      </Link>
      <div className="ticker-track">
        {lines.length === 0 ? (
          <span className="ticker-empty">{tr.t('ui.ticker.empty')}</span>
        ) : (
          <div className="ticker-run" style={{ animationDuration: `${dur}s` }} key={lines[0]!.id}>
            {[0, 1].map((copy) => (
              <span className="ticker-copy" key={copy} aria-hidden={copy === 1}>
                {lines.map((h) => (
                  <button
                    type="button"
                    key={`${copy}-${h.id}`}
                    className={`ticker-item tone-${h.tone}`}
                    tabIndex={copy === 1 ? -1 : 0}
                    onClick={() => {
                      if (h.room) {
                        controller.openRoom(h.room);
                        controller.commands?.focusRoom(h.room);
                      } else navigate(`/h/${encodeURIComponent(h.id)}`);
                    }}
                  >
                    {h.title}
                  </button>
                ))}
              </span>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
