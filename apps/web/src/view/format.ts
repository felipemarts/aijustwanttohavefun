/** Numbers, dates and relative times through `Intl`, in the viewer's language. Formatters are cached. */

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function nf(lang: string, o: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `n|${lang}|${JSON.stringify(o)}`;
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) cache.set(k, (f = new Intl.NumberFormat(lang, o)));
  return f;
}

function df(lang: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `d|${lang}|${JSON.stringify(o)}`;
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) cache.set(k, (f = new Intl.DateTimeFormat(lang, o)));
  return f;
}

function rf(lang: string): Intl.RelativeTimeFormat {
  const k = `r|${lang}`;
  let f = cache.get(k) as Intl.RelativeTimeFormat | undefined;
  if (!f) cache.set(k, (f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'long' })));
  return f;
}

export const fmtInt = (lang: string, n: number) => nf(lang, { maximumFractionDigits: 0 }).format(n);
export const fmtCompact = (lang: string, n: number) =>
  nf(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const fmtPct = (lang: string, f: number, digits = 0) =>
  nf(lang, { style: 'percent', maximumFractionDigits: digits }).format(f);

/** A full timestamp, short: "Nov 27, 14:05". */
export const fmtDateTime = (lang: string, ts: number) =>
  df(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ts);

export const fmtTime = (lang: string, ts: number) => df(lang, { hour: '2-digit', minute: '2-digit' }).format(ts);

/** A UTC calendar day (`YYYY-MM-DD`) as the reader says it. */
export function fmtDay(lang: string, day: string, style: 'long' | 'short' | 'axis' = 'long'): string {
  const ts = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(ts)) return day;
  const o: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
      : style === 'short'
        ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
        : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return df(lang, o).format(ts);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
];

/** "3 hours ago", "in 2 days". */
export function fmtRelative(lang: string, ts: number, now: number): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  for (const [unit, ms] of UNITS) {
    if (abs >= ms || unit === 'second') return rf(lang).format(Math.round(diff / ms), unit);
  }
  return '';
}

/** A countdown like "2 d 4 h" or "35 min", with Intl unit names. */
export function fmtDuration(lang: string, ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const u = (n: number, unit: string) => nf(lang, { style: 'unit', unit, unitDisplay: 'narrow' }).format(n);
  if (d > 0) return h > 0 ? `${u(d, 'day')} ${u(h, 'hour')}` : u(d, 'day');
  if (h > 0) return m > 0 ? `${u(h, 'hour')} ${u(m, 'minute')}` : u(h, 'hour');
  return u(m, 'minute');
}
