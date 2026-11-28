/**
 * Node implementations of the ports, file-backed: for the harness and for tests. The phone implements the same
 * interfaces with expo-secure-store, expo-sqlite, expo-file-system and llama.rn.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Clock, DownloadRequest, Fetch, KeyVault, ModelFiles, ModelRuntime, RandomSource, Storage, TimerHandle } from '../ports.ts';

const MAX_TIMEOUT = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const t = setTimeout(fn, Math.min(MAX_TIMEOUT, Math.max(0, ms)));
    return { cancel: () => clearTimeout(t) };
  },
};

export const nodeFetch: Fetch = (input, init) => fetch(input, init);

export const nodeRandom: RandomSource = (n) => new Uint8Array(randomBytes(n));

async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

/** Secrets in one JSON file readable only by its owner (0600). For the harness; not a keystore. */
export class FileKeyVault implements KeyVault {
  private readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(dir: string) {
    this.path = join(dir, 'vault.json');
  }
  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async get(name: string): Promise<string | null> {
    const all = await this.read();
    return Object.prototype.hasOwnProperty.call(all, name) ? (all[name] ?? null) : null;
  }
  set(name: string, value: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.read();
      all[name] = value;
      await atomicWrite(this.path, JSON.stringify(all));
      await chmod(this.path, 0o600);
    });
  }
  delete(name: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.read();
      delete all[name];
      await atomicWrite(this.path, JSON.stringify(all));
    });
  }
}

/** One file per key in a directory. Good enough for the harness; the phone uses SQLite. */
export class FileStorage implements Storage {
  private readonly dir: string;
  private ready: Promise<unknown>;
  constructor(dir: string) {
    this.dir = dir;
    this.ready = mkdir(dir, { recursive: true });
  }
  private file(key: string): string {
    return join(this.dir, encodeURIComponent(key));
  }
  async get(key: string): Promise<string | null> {
    await this.ready;
    try {
      return await readFile(this.file(key), 'utf8');
    } catch {
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    await this.ready;
    await atomicWrite(this.file(key), value);
  }
  async delete(key: string): Promise<void> {
    await this.ready;
    await rm(this.file(key), { force: true });
  }
  async list(prefix: string, opts: { before?: string; after?: string; limit?: number; reverse?: boolean } = {}): Promise<{ key: string; value: string }[]> {
    await this.ready;
    let keys = (await readdir(this.dir)).filter((f) => !f.endsWith('.tmp')).map((f) => decodeURIComponent(f)).filter((k) => k.startsWith(prefix)).sort();
    if (opts.before !== undefined) keys = keys.filter((k) => k < opts.before!);
    if (opts.after !== undefined) keys = keys.filter((k) => k > opts.after!);
    if (opts.reverse) keys.reverse();
    if (opts.limit !== undefined) keys = keys.slice(0, opts.limit);
    const out: { key: string; value: string }[] = [];
    for (const key of keys) {
      const value = await this.get(key);
      if (value !== null) out.push({ key, value });
    }
    return out;
  }
}

/**
 * Model files in a directory: HTTP Range resume from `<name>.part`, SHA-256 check, then rename. The download
 * carries no credentials, so following the CDN redirect is fine.
 */
export class NodeModelFiles implements ModelFiles {
  private readonly dir: string;
  private readonly fetch: Fetch;
  constructor(dir: string, f: Fetch = nodeFetch) {
    this.dir = dir;
    this.fetch = f;
  }
  private final(name: string): string {
    return join(this.dir, name.replace(/[/\\]/g, '_'));
  }
  async freeBytes(): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const s = await statfs(this.dir);
    return s.bavail * s.bsize;
  }
  async stat(name: string): Promise<{ bytes: number; complete: boolean } | null> {
    const done = await stat(this.final(name)).catch(() => null);
    if (done) return { bytes: done.size, complete: true };
    const part = await stat(`${this.final(name)}.part`).catch(() => null);
    return part ? { bytes: part.size, complete: false } : null;
  }
  async path(name: string): Promise<string | null> {
    return (await stat(this.final(name)).catch(() => null)) ? this.final(name) : null;
  }
  async remove(name: string): Promise<void> {
    await rm(this.final(name), { force: true });
    await rm(`${this.final(name)}.part`, { force: true });
  }
  async download(req: DownloadRequest): Promise<{ path: string }> {
    await mkdir(this.dir, { recursive: true });
    const part = `${this.final(req.name)}.part`;
    let have = (await stat(part).catch(() => null))?.size ?? 0;
    if (have > req.bytes) {
      await rm(part, { force: true });
      have = 0;
    }
    if (have < req.bytes) {
      const res = await this.fetch(req.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: req.signal });
      if (res.status === 200) have = 0;
      else if (res.status !== 206) throw new Error(`download failed: HTTP ${res.status}`);
      if (!res.body) throw new Error('download failed: empty body');
      const out = createWriteStream(part, { flags: have ? 'a' : 'w', mode: 0o600 });
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
          have += value.byteLength;
          req.onProgress?.(have, req.bytes);
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
    }
    if (have !== req.bytes) throw new Error('download failed: wrong size');
    if (req.sha256) {
      const h = createHash('sha256');
      await new Promise<void>((resolve, reject) => createReadStream(part).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject));
      if (h.digest('hex') !== req.sha256) {
        await rm(part, { force: true });
        throw new Error('download failed: checksum mismatch');
      }
    }
    await rename(part, this.final(req.name));
    return { path: this.final(req.name) };
  }
}

/** The harness does not run a model itself (it uses an OpenAI-compatible URL); this runtime refuses to load. */
export class UnavailableRuntime implements ModelRuntime {
  async load(): Promise<void> {
    throw new Error('no on-device runtime in Node');
  }
  loaded(): string | null {
    return null;
  }
  async complete(): Promise<{ text: string; tokens: number }> {
    throw new Error('no on-device runtime in Node');
  }
  async unload(): Promise<void> {}
}
