import { useHighlights } from '../data/store';
import { useT } from '../i18n/store';
import { formatEvent } from '../i18n/translator';
import { controller } from '../map/controller';

/** A slow ticker of the big moments of the world (level ups, feats, falls, rare loot, newcomers). */
export function HighlightsTicker() {
  const tr = useT();
  const all = useHighlights();
  const items = all.slice(-8).reverse();
  const lines = items.map((ev) => ({ ev, text: formatEvent(tr, ev) })).filter((x) => x.text.kind === 'line');
  // Duration grows with content so the reading speed stays the same.
  const chars = lines.reduce((n, l) => n + (l.text.kind === 'line' ? l.text.text.length : 0), 0);
  const dur = Math.max(30, Math.round(chars / 5));
  return (
    <aside className="ticker" aria-label={tr.t('ui.ticker.label')}>
      <span className="ticker-label">{tr.t('ui.ticker.label')}</span>
      <div className="ticker-track">
        {lines.length === 0 ? (
          <span className="ticker-empty">{tr.t('ui.ticker.empty')}</span>
        ) : (
          <div className="ticker-run" style={{ animationDuration: `${dur}s` }} key={lines[0]!.ev.id}>
            {[0, 1].map((copy) => (
              <span className="ticker-copy" key={copy} aria-hidden={copy === 1}>
                {lines.map(({ ev, text }) => (
                  <button
                    type="button"
                    key={`${copy}-${ev.id}`}
                    className={`ticker-item type-${ev.type}`}
                    tabIndex={copy === 1 ? -1 : 0}
                    onClick={() => {
                      if (ev.room) {
                        controller.openRoom(ev.room);
                        controller.commands?.focusRoom(ev.room);
                      }
                    }}
                  >
                    {text.kind === 'line' ? text.text : ''}
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
