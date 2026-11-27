/**
 * Web Push in this browser: the service worker (`/sw.js`), the permission prompt (only ever from a click) and the
 * subscription the server stores. The page never asks for permission on its own.
 */
import type { OwnerClient, OwnerError } from './client';

export type PushState = 'unsupported' | 'disabled' | 'denied' | 'off' | 'on';
export type PushResult = { ok: true; state: PushState } | { ok: false; state: PushState; error: OwnerError | null };

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** `applicationServerKey` from the base64url VAPID public key. */
export function vapidKeyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? null;
  } catch {
    return null;
  }
}

/** What the browser says now, without prompting and without registering anything. */
export async function currentPushState(serverEnabled: boolean): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!serverEnabled) return 'disabled';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return sub ? 'on' : 'off';
}

/** Click handler of "Turn on": permission prompt, service worker, subscription, then the server. */
export async function enablePush(client: OwnerClient): Promise<PushResult> {
  if (!pushSupported()) return { ok: false, state: 'unsupported', error: null };
  // First, while the click still counts as a user gesture (Safari drops it after a network round trip).
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, state: permission === 'denied' ? 'denied' : 'off', error: null };
  const key = await client.pushKey();
  if (!key.ok) return { ok: false, state: key.error.code === 'PUSH_DISABLED' ? 'disabled' : 'off', error: key.error };
  const publicKey = typeof key.data.public_key === 'string' ? key.data.public_key : '';
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(publicKey)) return { ok: false, state: 'off', error: null };
  let sub: PushSubscription;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(publicKey) }));
  } catch {
    return { ok: false, state: 'off', error: null };
  }
  const j = sub.toJSON();
  const res = await client.pushSubscribe({ endpoint: sub.endpoint, keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' } });
  if (!res.ok) {
    // The server refused it: do not leave a subscription nobody will ever send to.
    await sub.unsubscribe().catch(() => false);
    return { ok: false, state: res.error.code === 'PUSH_DISABLED' ? 'disabled' : 'off', error: res.error };
  }
  return { ok: true, state: 'on' };
}

/** "Turn off": the browser forgets the subscription and the server deletes it. */
export async function disablePush(client: OwnerClient): Promise<PushResult> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (!sub) return { ok: true, state: 'off' };
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  const res = await client.pushUnsubscribe(endpoint);
  if (!res.ok && res.error.code !== 'PUSH_DISABLED') return { ok: false, state: 'off', error: res.error };
  return { ok: true, state: 'off' };
}
