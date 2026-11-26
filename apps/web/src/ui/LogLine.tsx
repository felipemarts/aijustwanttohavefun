import type { SpectatorEvent } from '@ajwf/shared';
import { memo } from 'react';
import { formatEvent, type Translator } from '../i18n/translator';

const TYPE_CLASS: Record<string, string> = {
  attack: 'is-combat',
  kill: 'is-combat',
  fallen: 'is-danger',
  level_up: 'is-gold',
  achievement: 'is-gold',
  world_first: 'is-gold',
  rare_drop: 'is-gold',
  arrival: 'is-teal',
  heal: 'is-teal',
  revive: 'is-teal',
};

/** Only events with a narration key or agent text belong in a log (spawns and clock ticks do not). */
export function isLoggable(ev: SpectatorEvent): boolean {
  return typeof ev.k === 'string' || typeof ev.text === 'string';
}

/** Language tags are untrusted: keep only a short BCP-47-looking value for `lang` and the chip. */
export function safeLang(lang: string | null | undefined): string | null {
  return lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(lang) ? lang : null;
}

/**
 * One room-log line. Narration is localized; agent text is untrusted and rendered only as a text node inside a
 * quote with its language tag, never as markup.
 */
export const LogLine = memo(function LogLine({
  ev,
  tr,
  time,
  onAgent,
}: {
  ev: SpectatorEvent;
  tr: Translator;
  time: string;
  onAgent?: (name: string) => void;
}) {
  const line = formatEvent(tr, ev);
  if (line.kind === 'speech') {
    const lang = safeLang(line.lang);
    return (
      <li className="log-line is-speech">
        <time className="log-time">{time}</time>
        <span className="log-body">
          <button type="button" className="link-btn speaker" onClick={() => onAgent?.(line.actor)}>
            {line.actor}
          </button>
          {lang ? (
            <span className="lang-chip" title={tr.t('ui.log.written_in', { lang })}>
              {lang}
            </span>
          ) : null}
          <q className="speech" lang={lang ?? undefined} dir="auto">
            {line.text}
          </q>
        </span>
      </li>
    );
  }
  return (
    <li className={`log-line ${TYPE_CLASS[line.type] ?? ''}`}>
      <time className="log-time">{time}</time>
      <span className="log-body">{line.text}</span>
    </li>
  );
});
