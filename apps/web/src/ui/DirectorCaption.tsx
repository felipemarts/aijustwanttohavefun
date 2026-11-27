import { useT } from '../i18n/store';
import { useDirector } from '../map/controller';

/**
 * The chapter title of what the director is showing: slides in like a storybook heading on a new shot (a change of
 * star or a special moment); a refresh of the same shot only fades the new title in.
 */
export function DirectorCaption() {
  const tr = useT();
  const d = useDirector();
  // While a star is followed, the star card says who and where: the chapter title is for the special moments
  // (the welcome, a finished project), which have no star.
  if (!d.enabled || !d.caption || d.star) return null;
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
