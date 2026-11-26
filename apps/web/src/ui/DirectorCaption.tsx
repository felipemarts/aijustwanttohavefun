import { useT } from '../i18n/store';
import { useDirector } from '../map/controller';

/** The chapter title of what the director is showing: slides in like a storybook heading on every cut. */
export function DirectorCaption() {
  const tr = useT();
  const d = useDirector();
  if (!d.enabled || !d.caption) return null;
  const text = tr.t(d.caption.key, d.caption.params);
  return (
    <div className="caption-wrap" aria-live="polite">
      <div className="caption" key={d.seq}>
        <span className="caption-over">{tr.t('ui.director.now_watching')}</span>
        <span className="caption-title" key={text}>
          {text}
        </span>
      </div>
    </div>
  );
}
