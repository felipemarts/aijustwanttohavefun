/*
 * The owner's notifications (PLANEJAMENTO §14.2). Only two jobs: show a push message, and open its page on click.
 * No caching, no fetch handler. The payload is `{title, body, url, tag}`; `url` is opened only when it belongs to
 * this site, so a message can never send the owner somewhere else.
 */

/** The address to open for a notification: `raw` resolved against this site, or null when it is not on this site. */
function safeTargetUrl(raw, origin) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw, origin);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.origin !== new URL(origin).origin) return null;
  return u.href;
}

const FALLBACK_PATH = '/owner';

function text(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  const origin = self.location.origin;
  const title = text(data.title, 120) || self.location.hostname;
  const options = {
    body: text(data.body, 300),
    tag: text(data.tag, 64) || undefined,
    icon: '/favicon.svg',
    data: { url: safeTargetUrl(data.url, origin) || new URL(FALLBACK_PATH, origin).href },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const origin = self.location.origin;
  const target = safeTargetUrl(event.notification.data && event.notification.data.url, origin) || new URL(FALLBACK_PATH, origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if (c.url === target && 'focus' in c) return c.focus();
      return self.clients.openWindow(target);
    }),
  );
});
