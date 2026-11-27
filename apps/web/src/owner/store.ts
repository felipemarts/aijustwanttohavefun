/**
 * Owner state, outside React like the live store: who is signed in (for the navigation) and the dashboard's
 * `/api/owner/me`. It lives in memory only: nothing owner-related is written to localStorage, and API keys never
 * pass through here (the key panel keeps a new key in its own component state).
 */
import { useSyncExternalStore } from 'react';
import { config } from '../config';
import { i18n } from '../i18n/store';
import { type FetchFn, OwnerClient, type OwnerError } from './client';
import { type OwnerAgent, type OwnerMe, parseMe, parseSession, type SessionInfo } from './parse';

export type OwnerSnapshot = {
  /** `unknown` until the first answer; the navigation shows the anonymous label meanwhile. */
  session: 'unknown' | 'anon' | 'in';
  name: string | null;
  me: { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: OwnerMe } | { status: 'anon' } | { status: 'error'; error: OwnerError };
};

type Listener = () => void;

export class OwnerStore {
  snap: OwnerSnapshot = { session: 'unknown', name: null, me: { status: 'idle' } };
  private listeners = new Set<Listener>();
  private clientP: Promise<OwnerClient> | null = null;
  private sessionAsked = false;
  private meSeq = 0;

  /** `makeFetch` decides the transport once (tests pass one; demo mode an in-memory API). */
  constructor(private makeFetch: () => Promise<FetchFn>) {}

  client(): Promise<OwnerClient> {
    this.clientP ??= this.makeFetch().then((f) => new OwnerClient(f));
    return this.clientP;
  }

  /** Mock mode: login buttons sign in at once instead of leaving for a provider. */
  get demo(): boolean {
    return config.mock;
  }

  private set(next: Partial<OwnerSnapshot>) {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l();
  }

  private signedIn(s: SessionInfo) {
    this.set({ session: s ? 'in' : 'anon', name: s?.name ?? null });
  }

  /** For the navigation: asked once per page load (a 200 either way, so no error in the console). */
  async checkSession(force = false): Promise<void> {
    if (this.sessionAsked && !force) return;
    this.sessionAsked = true;
    const res = await (await this.client()).session();
    if (res.ok) this.signedIn(parseSession(res.data));
  }

  /** The dashboard's data. A 401 means signed out. */
  async loadMe(): Promise<void> {
    const seq = ++this.meSeq;
    if (this.snap.me.status !== 'ready') this.set({ me: { status: 'loading' } });
    const res = await (await this.client()).me();
    if (seq !== this.meSeq) return;
    if (res.ok) {
      const data = parseMe(res.data);
      if (data) {
        this.set({ me: { status: 'ready', data }, session: 'in', name: data.owner.name });
        return;
      }
      this.set({ me: { status: 'error', error: { code: 'BAD_RESPONSE', message: '', hint: null, status: 200, retryAfter: null } } });
      return;
    }
    if (res.error.code === 'UNAUTHORIZED') this.set({ me: { status: 'anon' }, session: 'anon', name: null });
    else this.set({ me: { status: 'error', error: res.error } });
  }

  /** Replaces one agent in the loaded dashboard (after a note, a retirement). */
  patchAgent(id: string, patch: Partial<OwnerAgent>) {
    const me = this.snap.me;
    if (me.status !== 'ready') return;
    this.set({ me: { status: 'ready', data: { ...me.data, agents: me.data.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) } } });
  }

  /** After logout or account deletion: everything owner-related is dropped from memory. */
  signedOut() {
    this.meSeq++;
    this.set({ session: 'anon', name: null, me: { status: 'anon' } });
  }

  async logout(): Promise<OwnerError | null> {
    const res = await (await this.client()).logout();
    if (!res.ok) return res.error;
    this.signedOut();
    return null;
  }

  /** Dev login (local servers with DEV_LOGIN=1, and the demo). */
  async devLogin(name?: string): Promise<OwnerError | null> {
    const res = await (await this.client()).devLogin(name);
    if (!res.ok) return res.error;
    await this.loadMe();
    return null;
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

async function defaultFetch(): Promise<FetchFn> {
  if (config.mock) {
    const { mockOwnerFetch } = await import('./mock');
    const signedIn = typeof window === 'undefined' || new URLSearchParams(window.location.search).get('owner') !== 'anon';
    return mockOwnerFetch(() => i18n.tr, { signedIn });
  }
  return (url, init) => fetch(url, init);
}

export const ownerStore = new OwnerStore(defaultFetch);

const getSnap = () => ownerStore.snap;

export function useOwner(): OwnerSnapshot {
  return useSyncExternalStore(ownerStore.subscribe, getSnap, getSnap);
}
