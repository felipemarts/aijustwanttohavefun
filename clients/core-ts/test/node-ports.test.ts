import { createHash } from 'node:crypto';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKeyVault, FileStorage, NodeModelFiles, UnavailableRuntime, systemClock } from '../src/node/index.ts';
import { httpServer } from './helpers.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const dir = () => mkdtemp(join(tmpdir(), 'core-ts-'));

describe('Node ports', () => {
  it('FileStorage is an ordered key range store', async () => {
    const s = new FileStorage(await dir());
    for (const k of ['log/a/003', 'log/a/001', 'log/a/002', 'log/b/001', 'char/a']) await s.set(k, JSON.stringify(k));
    expect((await s.list('log/a/')).map((r) => r.key)).toEqual(['log/a/001', 'log/a/002', 'log/a/003']);
    expect((await s.list('log/a/', { reverse: true, limit: 2 })).map((r) => r.key)).toEqual(['log/a/003', 'log/a/002']);
    expect((await s.list('log/a/', { before: 'log/a/003', reverse: true })).map((r) => r.key)).toEqual(['log/a/002', 'log/a/001']);
    expect((await s.list('log/a/', { after: 'log/a/001' })).map((r) => r.key)).toEqual(['log/a/002', 'log/a/003']);
    await s.delete('log/a/002');
    expect(await s.get('log/a/002')).toBeNull();
    expect(await s.get('char/a')).toBe('"char/a"');
  });

  it('FileKeyVault keeps secrets in a file only its owner can read', async () => {
    const d = await dir();
    const v = new FileKeyVault(d);
    await Promise.all([v.set('a', '1'), v.set('b', '2'), v.set('c', '3')]);
    expect(await v.get('b')).toBe('2');
    await v.delete('b');
    expect(await v.get('b')).toBeNull();
    expect(await v.get('__proto__')).toBeNull();
    expect((await stat(join(d, 'vault.json'))).mode & 0o777).toBe(0o600);
  });

  it('NodeModelFiles resumes with a Range request and checks the SHA-256', async () => {
    const data = Buffer.alloc(300_000, 7);
    data.write('model', 0);
    const sha = createHash('sha256').update(data).digest('hex');
    const ranges: (string | undefined)[] = [];
    const srv = await httpServer((req, res) => {
      ranges.push(req.headers.range);
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      const from = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, { 'content-length': String(data.length - from) });
      res.end(data.subarray(from));
    });
    closers.push(srv.close);
    const d = await dir();
    const files = new NodeModelFiles(d);
    expect(await files.freeBytes()).toBeGreaterThan(0);
    // A partial file from an earlier, interrupted download.
    await writeFile(join(d, 'm.gguf.part'), data.subarray(0, 100_000));
    expect(await files.stat('m.gguf')).toEqual({ bytes: 100_000, complete: false });
    const progress: number[] = [];
    const out = await files.download({ url: `${srv.url}/m.gguf`, name: 'm.gguf', bytes: data.length, sha256: sha, onProgress: (n) => progress.push(n) });
    expect(ranges).toEqual(['bytes=100000-']);
    expect(progress.at(-1)).toBe(data.length);
    expect(await files.path('m.gguf')).toBe(out.path);
    expect(await files.stat('m.gguf')).toEqual({ bytes: data.length, complete: true });
    await files.remove('m.gguf');
    expect(await files.stat('m.gguf')).toBeNull();
    // A wrong checksum is refused and the bad file dropped.
    await expect(files.download({ url: `${srv.url}/m.gguf`, name: 'm.gguf', bytes: data.length, sha256: 'f'.repeat(64) })).rejects.toThrow(/checksum/);
    expect(await files.stat('m.gguf')).toBeNull();
    // Abort keeps the partial file.
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(files.download({ url: `${srv.url}/m.gguf`, name: 'm.gguf', bytes: data.length, sha256: sha, signal: ctrl.signal })).rejects.toThrow();
  });

  it('the clock and the unavailable runtime behave', async () => {
    let fired = false;
    systemClock.setTimeout(() => (fired = true), 0).cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect(fired).toBe(false);
    const rt = new UnavailableRuntime();
    expect(rt.loaded()).toBeNull();
    await expect(rt.load()).rejects.toThrow();
    await expect(rt.complete()).rejects.toThrow();
  });
});
