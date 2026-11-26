import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/store';

/** "Put your agent in the game": the one sentence an owner gives their agent, with a copy button. */
export function Cta() {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const url = `${window.location.origin}/skill.md`;
  const sentence = tr.t('ui.cta.sentence', { url });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    dialogRef.current?.querySelector<HTMLButtonElement>('.copy-btn')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sentence);
    } catch {
      const el = dialogRef.current?.querySelector('code');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      <button type="button" className="btn btn-cta" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="cta-long">{tr.t('ui.cta.button')}</span>
        <span className="cta-short" aria-hidden="true">
          {tr.t('ui.cta.button_short')}
        </span>
      </button>
      {open ? (
        <div className="dialog-scrim" onClick={() => setOpen(false)}>
          <div
            className="dialog pixel-box"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            ref={dialogRef}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={titleId} className="heading">
              {tr.t('ui.cta.title')}
            </h2>
            <p>{tr.t('ui.cta.body')}</p>
            <div className="sentence">
              <code>{sentence}</code>
              <button type="button" className="btn btn-primary copy-btn" onClick={() => void copy()}>
                {copied ? tr.t('ui.cta.copied') : tr.t('ui.cta.copy')}
              </button>
            </div>
            <p className="muted small">{tr.t('ui.cta.note')}</p>
            <button
              type="button"
              className="btn btn-icon btn-ghost dialog-close"
              onClick={() => setOpen(false)}
              aria-label={tr.t('ui.common.close')}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
