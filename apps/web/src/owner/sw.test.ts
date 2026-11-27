/**
 * The shipped service worker (`public/sw.js`), run as is in a sandbox with a fake `self`: its URL check, and what the
 * push and click handlers do with hostile payloads.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://game.example';

type Handler = (event: Record<string, unknown>) => void;

function loadWorker() {
  const handlers = new Map<string, Handler>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  let windows: { url: string; focus: () => Promise<void> }[] = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, h: Handler) => handlers.set(type, h),
    skipWaiting: vi.fn(),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
  };
  const ctx = createContext({ self, URL });
  runInContext(SOURCE, ctx);
  const safeTargetUrl = ctx.safeTargetUrl as (raw: unknown, origin: string) => string | null;
  async function fire(type: string, event: Record<string, unknown>) {
    let done: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  }
  return {
    safeTargetUrl,
    shown,
    opened,
    focused,
    setWindows: (urls: string[]) => {
      windows = urls.map((url) => ({ url, focus: async () => void focused.push(url) }));
    },
    push: (data: unknown) => fire('push', { data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } }),
    click: (url: unknown) => fire('notificationclick', { notification: { data: { url }, close: vi.fn() } }),
  };
}

describe('service worker: safeTargetUrl', () => {
  const { safeTargetUrl } = loadWorker();

  it('accepts this site only', () => {
    expect(safeTargetUrl(`${ORIGIN}/a/Pip`, ORIGIN)).toBe(`${ORIGIN}/a/Pip`);
    expect(safeTargetUrl('/owner?agent=a1b', ORIGIN)).toBe(`${ORIGIN}/owner?agent=a1b`);
    expect(safeTargetUrl(`${ORIGIN}/a/P%C3%ADp#x`, ORIGIN)).toBe(`${ORIGIN}/a/P%C3%ADp#x`);
  });

  it.each([
    'https://evil.example/a/Pip',
    '//evil.example/a/Pip',
    '/\\evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://game.example/a/Pip',
    'https://game.example:8443/a/Pip',
    'https://game.example.evil.example/',
    'https://user:pass@game.example/a/Pip',
    'blob:https://game.example/uuid',
    '',
    'x'.repeat(3000),
  ])('refuses %s', (raw) => {
    expect(safeTargetUrl(raw, ORIGIN)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const v of [null, undefined, 42, { href: ORIGIN }, [ORIGIN]]) expect(safeTargetUrl(v, ORIGIN)).toBeNull();
  });
});

describe('service worker: handlers', () => {
  it('shows the payload, keeping a same-origin url', async () => {
    const w = loadWorker();
    await w.push({ title: 'Pip reached level 10!', body: 'A big milestone.', url: `${ORIGIN}/a/Pip`, tag: 'level:a1b' });
    expect(w.shown).toEqual([{ title: 'Pip reached level 10!', options: { body: 'A big milestone.', tag: 'level:a1b', icon: '/favicon.svg', data: { url: `${ORIGIN}/a/Pip` } } }]);
  });

  it('replaces a foreign url with the dashboard, and survives junk payloads', async () => {
    const w = loadWorker();
    await w.push({ title: 'x', body: 'y', url: 'https://evil.example/phish' });
    await w.push('not json at all {');
    await w.push({ title: 42, body: { html: '<b>' }, url: 'javascript:alert(1)', tag: 'x'.repeat(500) });
    expect(w.shown.map((s) => (s.options.data as { url: string }).url)).toEqual([`${ORIGIN}/owner`, `${ORIGIN}/owner`, `${ORIGIN}/owner`]);
    expect(w.shown[2]!.title).toBe('game.example');
    expect(w.shown[2]!.options.body).toBe('');
    expect((w.shown[2]!.options.tag as string).length).toBe(64);
  });

  it('on click: focuses an open tab on that page, opens a new one otherwise, and never leaves the site', async () => {
    const w = loadWorker();
    w.setWindows([`${ORIGIN}/a/Pip`]);
    await w.click(`${ORIGIN}/a/Pip`);
    expect(w.focused).toEqual([`${ORIGIN}/a/Pip`]);
    await w.click(`${ORIGIN}/a/Bo`);
    // The notification's data could have been written by anyone with the subscription: checked again here.
    await w.click('https://evil.example/');
    expect(w.opened).toEqual([`${ORIGIN}/a/Bo`, `${ORIGIN}/owner`]);
  });
});
