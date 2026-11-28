/**
 * `ModelFiles` on expo-file-system, for the 1.1 GB built-in model.
 *
 * Layout in the model directory, for a file `name`:
 *   <name>.part           the download in progress (written by the native download task)
 *   <name>.part.json      the native pause state, so a paused download resumes after an app restart
 *   <name>                the finished file, renamed from .part once all bytes are there
 *   <name>.verified.json  { size, mtime, sha256 } once its SHA-256 matched the pin
 * Integrity: the finished file is hashed once, in chunks read through a file handle (never the whole file in memory),
 * with progress reported to `onVerify` (the engine screen shows "Checking the download"). The result is remembered
 * against size and modification time, so later starts do not hash 1.1 GB again.
 */
import type { DownloadRequest, ModelFiles } from '@ajwf/client-core';

export type FsInfo = { exists: boolean; size: number; mtime: number | null };
export type FsReadHandle = { readBytes(n: number): Promise<Uint8Array>; close(): void };
/** One native download, started fresh or from a saved pause state. */
export type FsDownload = {
  /** Resolves 'done' when every byte is written to the destination, 'paused' when it was paused. */
  run(): Promise<'done' | 'paused'>;
  /** Pauses and returns the state to resume from later (serializable). */
  pause(): Promise<unknown>;
  cancel(): void;
};
/** The part of expo-file-system this adapter uses, so tests can fake it. */
export type FsApi = {
  /** Directory URI that holds the models (created on demand); ends without a slash. */
  dir: string;
  ensureDir(): void;
  info(uri: string): FsInfo;
  open(uri: string): FsReadHandle;
  readText(uri: string): Promise<string | null>;
  writeText(uri: string, text: string): Promise<void>;
  remove(uri: string): void;
  move(from: string, to: string): void;
  freeBytes(): number;
  download(url: string, toUri: string, onProgress: (bytesWritten: number, totalBytes: number) => void, resumeState?: unknown): FsDownload;
};
export type Hasher = { update(chunk: Uint8Array): void; hex(): string };

export type ModelFilesOptions = {
  fs: FsApi;
  sha256: () => Hasher;
  /** Hashing progress of a finished download (the app shows it; the contract has no field for it yet). */
  onVerify?: (name: string, bytesDone: number, bytesTotal: number) => void;
  chunkBytes?: number;
  /** Free space kept beyond the download itself. */
  marginBytes?: number;
};

type PauseRecord = { url: string; bytes: number; bytesDone: number; state: unknown };
type VerifiedRecord = { size: number; mtime: number | null; sha256: string };

export class ModelFilesError extends Error {
  readonly code: 'NO_SPACE' | 'INCOMPLETE' | 'CORRUPT';
  constructor(code: ModelFilesError['code'], message: string) {
    super(message);
    this.name = 'ModelFilesError';
    this.code = code;
  }
}

function abortError(): Error {
  const e = new Error('The download was paused.');
  e.name = 'AbortError';
  return e;
}

export function expoModelFiles(o: ModelFilesOptions): ModelFiles & { verify(name: string, sha256: string): Promise<boolean> } {
  const { fs } = o;
  const chunk = o.chunkBytes ?? 4 * 1024 * 1024;
  const margin = o.marginBytes ?? 200 * 1024 * 1024;
  const active = new Map<string, FsDownload>();
  const uri = (name: string) => `${fs.dir}/${name}`;
  const part = (name: string) => `${uri(name)}.part`;
  const pauseFile = (name: string) => `${uri(name)}.part.json`;
  const verifiedFile = (name: string) => `${uri(name)}.verified.json`;

  async function readJson<T>(u: string): Promise<T | null> {
    try {
      const t = await fs.readText(u);
      return t ? (JSON.parse(t) as T) : null;
    } catch {
      return null;
    }
  }

  async function verifiedOk(name: string, sha256?: string): Promise<boolean> {
    const info = fs.info(uri(name));
    if (!info.exists) return false;
    const rec = await readJson<VerifiedRecord>(verifiedFile(name));
    return !!rec && rec.size === info.size && rec.mtime === info.mtime && (sha256 === undefined || sha256 === '' || rec.sha256 === sha256);
  }

  /** Hashes the finished file in chunks; records the result when it matches. */
  async function verify(name: string, sha256: string): Promise<boolean> {
    const info = fs.info(uri(name));
    if (!info.exists) return false;
    const h = o.sha256();
    const handle = fs.open(uri(name));
    let done = 0;
    try {
      o.onVerify?.(name, 0, info.size);
      for (;;) {
        const bytes = await handle.readBytes(chunk);
        if (bytes.length === 0) break;
        h.update(bytes);
        done += bytes.length;
        o.onVerify?.(name, done, info.size);
      }
    } finally {
      handle.close();
    }
    const ok = h.hex() === sha256.toLowerCase();
    if (ok) await fs.writeText(verifiedFile(name), JSON.stringify({ size: info.size, mtime: info.mtime, sha256: sha256.toLowerCase() } satisfies VerifiedRecord));
    return ok;
  }

  async function removeAll(name: string) {
    for (const u of [uri(name), part(name), pauseFile(name), verifiedFile(name)]) {
      if (fs.info(u).exists) fs.remove(u);
    }
  }

  return {
    verify,

    async freeBytes() {
      return fs.freeBytes();
    },

    async stat(name) {
      const fin = fs.info(uri(name));
      if (fin.exists) return { bytes: fin.size, complete: await verifiedOk(name) };
      const paused = await readJson<PauseRecord>(pauseFile(name));
      if (paused) return { bytes: paused.bytesDone, complete: false };
      const p = fs.info(part(name));
      return p.exists ? { bytes: p.size, complete: false } : null;
    },

    async path(name) {
      return (await verifiedOk(name)) ? uri(name) : null;
    },

    async remove(name) {
      active.get(name)?.cancel();
      active.delete(name);
      await removeAll(name);
    },

    async download(req: DownloadRequest) {
      const { name } = req;
      fs.ensureDir();
      // Already here: verified, or finished but not yet checked (the app may have been killed while hashing).
      const fin = fs.info(uri(name));
      if (fin.exists) {
        if (await verifiedOk(name, req.sha256)) return { path: uri(name) };
        if (fin.size === req.bytes && (!req.sha256 || (await verify(name, req.sha256)))) {
          if (!req.sha256) await fs.writeText(verifiedFile(name), JSON.stringify({ size: fin.size, mtime: fin.mtime, sha256: '' }));
          return { path: uri(name) };
        }
        fs.remove(uri(name));
        if (fs.info(verifiedFile(name)).exists) fs.remove(verifiedFile(name));
      }
      // A pause state for another URL (a new pin) is useless: start over.
      let paused = await readJson<PauseRecord>(pauseFile(name));
      if (paused && (paused.url !== req.url || paused.bytes !== req.bytes)) {
        await removeAll(name);
        paused = null;
      }
      const have = paused?.bytesDone ?? 0;
      if (fs.freeBytes() < req.bytes - have + margin) {
        throw new ModelFilesError('NO_SPACE', `Not enough free space: the model needs ${req.bytes - have + margin} more bytes.`);
      }
      if (req.signal?.aborted) throw abortError();

      // Progress: a resumed native task may count from zero over the remaining range; then add what was there.
      let last = have;
      const onProgress = (written: number, total: number) => {
        last = total > 0 && total < req.bytes ? have + written : written;
        req.onProgress?.(last, req.bytes);
      };
      const task = fs.download(req.url, part(name), onProgress, paused?.state);
      active.set(name, task);
      let pausing: Promise<void> | null = null;
      const onAbort = () => {
        pausing ??= task.pause().then(
          (state) => fs.writeText(pauseFile(name), JSON.stringify({ url: req.url, bytes: req.bytes, bytesDone: last, state } satisfies PauseRecord)),
          () => undefined,
        );
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      let outcome: 'done' | 'paused';
      try {
        outcome = await task.run();
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
        active.delete(name);
      }
      if (outcome === 'paused' || req.signal?.aborted) {
        if (pausing) await pausing;
        throw abortError();
      }
      const got = fs.info(part(name));
      if (!got.exists || got.size !== req.bytes) {
        await removeAll(name);
        throw new ModelFilesError('INCOMPLETE', `The download ended at ${got.size} of ${req.bytes} bytes.`);
      }
      fs.move(part(name), uri(name));
      if (fs.info(pauseFile(name)).exists) fs.remove(pauseFile(name));
      if (req.sha256) {
        if (!(await verify(name, req.sha256))) {
          await removeAll(name);
          throw new ModelFilesError('CORRUPT', 'The downloaded file does not match its pinned SHA-256; it was deleted.');
        }
      } else {
        const done = fs.info(uri(name));
        await fs.writeText(verifiedFile(name), JSON.stringify({ size: done.size, mtime: done.mtime, sha256: '' } satisfies VerifiedRecord));
      }
      return { path: uri(name) };
    },
  };
}
