import { escapeHtml } from '@ajwf/shared';

/** What crawlers (X, WhatsApp, search engines) read from a page: they do not run JavaScript. */
export type PageMeta = {
  lang: string;
  title: string;
  description: string;
  /** Absolute URL of the share card. */
  image: string;
  /** Canonical absolute URL of the page. */
  url: string;
  siteName: string;
  noindex?: boolean;
};

const attr = (s: string) => escapeHtml(s);

function tags(m: PageMeta): string {
  const meta = (key: 'name' | 'property', k: string, v: string) => `<meta ${key}="${k}" content="${attr(v)}" />`;
  return [
    `<title>${escapeHtml(m.title)}</title>`,
    meta('name', 'description', m.description),
    `<link rel="canonical" href="${attr(m.url)}" />`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', m.siteName),
    meta('property', 'og:title', m.title),
    meta('property', 'og:description', m.description),
    meta('property', 'og:url', m.url),
    meta('property', 'og:image', m.image),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:alt', m.title),
    meta('property', 'og:locale', m.lang.replace('-', '_')),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', m.title),
    meta('name', 'twitter:description', m.description),
    meta('name', 'twitter:image', m.image),
    ...(m.noindex ? [meta('name', 'robots', 'noindex, nofollow')] : []),
  ].join('\n    ');
}

/**
 * Fills the page template with per-route meta tags. With the built web app, its `index.html` is the template (its
 * own title and description are replaced); without it, a minimal page with the same tags and a short text body.
 * Every interpolated value is HTML-escaped: names, titles and bios come from agents.
 */
export class Shell {
  private head: string;
  private tail: string;

  constructor(private template: string | null) {
    if (!template) {
      this.head = '';
      this.tail = '';
      return;
    }
    const cleaned = template
      .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
      .replace(/<meta\s+name=["']description["'][^>]*>\s*/i, '')
      .replace(/<html([^>]*)\slang=["'][^"']*["']/i, '<html$1');
    const at = cleaned.search(/<\/head>/i);
    if (at < 0) throw new Error('index.html has no </head>');
    this.head = cleaned.slice(0, at);
    this.tail = cleaned.slice(at);
  }

  render(m: PageMeta): string {
    const lang = attr(m.lang);
    if (this.template) {
      return `${this.head.replace(/<html/i, `<html lang="${lang}"`)}    ${tags(m)}\n  ${this.tail}`;
    }
    return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${tags(m)}
  </head>
  <body>
    <main>
      <h1>${escapeHtml(m.title)}</h1>
      <p>${escapeHtml(m.description)}</p>
      <p><a href="${attr(m.url)}">${escapeHtml(m.siteName)}</a></p>
    </main>
  </body>
</html>
`;
  }
}
