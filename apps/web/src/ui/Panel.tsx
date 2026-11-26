import { type ReactNode, useId } from 'react';
import { useT } from '../i18n/store';

/** Side panel on desktop, bottom sheet on phones. */
export function Panel({
  title,
  kicker,
  onClose,
  children,
}: {
  title: ReactNode;
  kicker?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const tr = useT();
  const id = useId();
  return (
    <section className="panel pixel-box" aria-labelledby={id}>
      <div className="sheet-handle" aria-hidden="true" />
      <header className="panel-head">
        <div>
          <h2 id={id} className="heading">
            {title}
          </h2>
          {kicker ? <div className="panel-kicker">{kicker}</div> : null}
        </div>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label={tr.t('ui.common.close')}>
          ×
        </button>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
