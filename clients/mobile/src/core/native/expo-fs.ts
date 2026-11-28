/**
 * The real `FsApi` (see files.ts) on expo-file-system's object API: `File`, `Directory`, `Paths`, `DownloadTask`.
 * Only imported by the native assembly (create-local.native.ts), never by the web bundle.
 */
import { Directory, DownloadTask, File, FileMode, Paths } from 'expo-file-system';
import type { DownloadPauseState } from 'expo-file-system';
import type { FsApi, FsDownload } from './files';

export function expoFsApi(): FsApi {
  const dir = new Directory(Paths.document, 'models');
  return {
    dir: dir.uri.replace(/\/+$/, ''),
    ensureDir() {
      if (!dir.exists) dir.create({ intermediates: true });
    },
    info(uri) {
      const f = new File(uri);
      return f.exists ? { exists: true, size: f.size, mtime: f.modificationTime } : { exists: false, size: 0, mtime: null };
    },
    open(uri) {
      const h = new File(uri).open(FileMode.ReadOnly);
      return { readBytes: (n) => h.readBytes(n), close: () => h.close() };
    },
    async readText(uri) {
      const f = new File(uri);
      return f.exists ? f.text() : null;
    },
    async writeText(uri, text) {
      await new File(uri).write(text);
    },
    remove(uri) {
      const f = new File(uri);
      if (f.exists) f.delete();
    },
    move(from, to) {
      new File(from).moveSync(new File(to));
    },
    freeBytes: () => Paths.availableDiskSpace,
    download(url, toUri, onProgress, resumeState): FsDownload {
      const options = { onProgress: (p: { bytesWritten: number; totalBytes: number }) => onProgress(p.bytesWritten, p.totalBytes) };
      const task = resumeState
        ? DownloadTask.fromSavable(resumeState as DownloadPauseState, options)
        : File.createDownloadTask(url, new File(toUri), options);
      return {
        async run() {
          const file = resumeState ? await task.resumeAsync() : await task.downloadAsync();
          return file ? 'done' : 'paused';
        },
        async pause() {
          await task.pauseAsync();
          return task.savable();
        },
        cancel: () => task.cancel(),
      };
    },
  };
}
