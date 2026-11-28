/**
 * The model-files adapter against an in-memory file system and a fake native download task that can pause and resume
 * (it reports progress over the remaining range after a resume, as a resumed native task may). Real SHA-256.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { expoModelFiles, type FsApi, type FsDownload } from './files';

const URL = 'https://huggingface.co/x/resolve/abc/model.gguf';

function fakeFs(remote: Uint8Array, free = 10_000_000) {
  const files = new Map<string, { data: Uint8Array; mtime: number }>();
  let clock = 1000;
  let hashedBytes = 0;
  const state = { free, starts: 0, resumes: 0 };
  const write = (uri: string, data: Uint8Array) => files.set(uri, { data, mtime: ++clock });
  const fs: FsApi = {
    dir: 'file:///doc/models',
    ensureDir() {},
    info(uri) {
      const f = files.get(uri);
      return f ? { exists: true, size: f.data.length, mtime: f.mtime } : { exists: false, size: 0, mtime: null };
    },
    open(uri) {
      const data = files.get(uri)!.data;
      let off = 0;
      return {
        async readBytes(n) {
          const out = data.slice(off, off + n);
          off += out.length;
          hashedBytes += out.length;
          return out;
        },
        close() {},
      };
    },
    async readText(uri) {
      const f = files.get(uri);
      return f ? new TextDecoder().decode(f.data) : null;
    },
    async writeText(uri, text) {
      write(uri, new TextEncoder().encode(text));
    },
    remove(uri) {
      files.delete(uri);
    },
    move(from, to) {
      const f = files.get(from)!;
      files.delete(from);
      files.set(to, f);
    },
    freeBytes: () => state.free,
    download(_url, toUri, onProgress, resume): FsDownload {
      const start = resume ? (resume as { offset: number }).offset : 0;
      if (resume) state.resumes++;
      else state.starts++;
      let offset = start;
      let pauseReq = false;
      let running: Promise<'done' | 'paused'> | null = null;
      return {
        run() {
          running = (async () => {
            while (offset < remote.length) {
              if (pauseReq) return 'paused';
              offset = Math.min(remote.length, offset + 100);
              write(toUri, remote.slice(0, offset));
              // A resumed task counts over the remaining range.
              onProgress(offset - start, remote.length - start);
              await new Promise((r) => setTimeout(r, 0));
            }
            return 'done';
          })();
          return running;
        },
        async pause() {
          pauseReq = true;
          await running;
          return { offset };
        },
        cancel() {
          pauseReq = true;
        },
      };
    },
  };
  return { fs, files, state, hashed: () => hashedBytes, touch: (uri: string) => (files.get(uri)!.mtime = ++clock) };
}

const hasher = () => {
  const h = sha256.create();
  return { update: (c: Uint8Array) => void h.update(c), hex: () => bytesToHex(h.digest()) };
};
const content = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 251);
const pin = bytesToHex(sha256(content));

describe('expoModelFiles', () => {
  it('downloads, checks the SHA-256 in chunks with progress, and remembers the result', async () => {
    const f = fakeFs(content);
    const verify: [number, number][] = [];
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, chunkBytes: 64, marginBytes: 0, onVerify: (_n, d, t) => verify.push([d, t]) });
    const progress: number[] = [];
    const out = await files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin, onProgress: (d) => progress.push(d) });
    expect(out.path).toBe('file:///doc/models/m.gguf');
    expect(progress.at(-1)).toBe(1000);
    expect(verify[0]).toEqual([0, 1000]);
    expect(verify.at(-1)).toEqual([1000, 1000]);
    expect(verify.length).toBeGreaterThan(10); // many chunks, never the whole file at once
    expect(await files.stat('m.gguf')).toEqual({ bytes: 1000, complete: true });
    expect(await files.path('m.gguf')).toBe(out.path);
    // A later start: already verified, no hashing again, no download.
    const hashedBefore = f.hashed();
    expect(await files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin })).toEqual(out);
    expect(f.hashed()).toBe(hashedBefore);
    expect(f.state.starts).toBe(1);
  });

  it('re-checks when the file changed on disk (modification time), without downloading again', async () => {
    const f = fakeFs(content);
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, chunkBytes: 256, marginBytes: 0 });
    await files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin });
    f.touch('file:///doc/models/m.gguf');
    expect(await files.stat('m.gguf')).toEqual({ bytes: 1000, complete: false });
    expect(await files.path('m.gguf')).toBeNull();
    const before = f.hashed();
    await files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin });
    expect(f.hashed() - before).toBe(1000);
    expect(f.state.starts).toBe(1);
  });

  it('deletes a file that does not match its pin', async () => {
    const f = fakeFs(content);
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, marginBytes: 0 });
    await expect(files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CORRUPT' });
    expect(await files.stat('m.gguf')).toBeNull();
    expect([...f.files.keys()]).toEqual([]);
  });

  it('pauses on abort keeping the partial file, then resumes from it with continuous progress', async () => {
    const f = fakeFs(content);
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, marginBytes: 0 });
    const ctl = new AbortController();
    const progress: number[] = [];
    const first = files.download({
      url: URL,
      name: 'm.gguf',
      bytes: 1000,
      sha256: pin,
      signal: ctl.signal,
      onProgress: (d) => {
        progress.push(d);
        if (d >= 400) ctl.abort();
      },
    });
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const partial = await files.stat('m.gguf');
    expect(partial!.complete).toBe(false);
    expect(partial!.bytes).toBeGreaterThanOrEqual(400);
    const resumed: number[] = [];
    await files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin, onProgress: (d) => resumed.push(d) });
    expect(f.state.resumes).toBe(1);
    expect(resumed[0]).toBeGreaterThan(partial!.bytes); // counts on from the partial file, not from zero
    expect(await files.stat('m.gguf')).toEqual({ bytes: 1000, complete: true });
  });

  it('starts over when the pin changed since the pause', async () => {
    const f = fakeFs(content);
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, marginBytes: 0 });
    const ctl = new AbortController();
    await expect(
      files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin, signal: ctl.signal, onProgress: (d) => d >= 300 && ctl.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await files.download({ url: `${URL}?rev=2`, name: 'm.gguf', bytes: 1000, sha256: pin });
    expect(f.state.resumes).toBe(0);
    expect(f.state.starts).toBe(2);
  });

  it('refuses to start without room for the rest of the file', async () => {
    const f = fakeFs(content, 500);
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, marginBytes: 0 });
    await expect(files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin })).rejects.toMatchObject({ code: 'NO_SPACE' });
    expect(await files.freeBytes()).toBe(500);
  });

  it('verifies a finished but unchecked file (app killed while hashing) instead of downloading it again', async () => {
    const f = fakeFs(content);
    f.files.set('file:///doc/models/m.gguf', { data: content, mtime: 5 });
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, marginBytes: 0 });
    expect(await files.stat('m.gguf')).toEqual({ bytes: 1000, complete: false });
    await files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin });
    expect(f.state.starts).toBe(0);
    expect(await files.stat('m.gguf')).toEqual({ bytes: 1000, complete: true });
  });

  it('remove deletes the file, the partial download and the records', async () => {
    const f = fakeFs(content);
    const files = expoModelFiles({ fs: f.fs, sha256: hasher, marginBytes: 0 });
    await files.download({ url: URL, name: 'm.gguf', bytes: 1000, sha256: pin });
    await files.remove('m.gguf');
    expect([...f.files.keys()]).toEqual([]);
    expect(await files.stat('m.gguf')).toBeNull();
  });
});
