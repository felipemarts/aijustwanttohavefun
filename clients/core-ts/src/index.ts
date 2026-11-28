/** `@ajwf/client-core`: the platform-neutral core. Node-only port implementations are in `./node`, test doubles in `./testing`. */
export type * from './api.ts';
export type { Clock, DownloadRequest, Fetch, KeyVault, ModelFiles, ModelRuntime, Ports, RandomSource, RuntimeMessage, RuntimeRequest, Storage, TimerHandle } from './ports.ts';
export { LocalCore, CORE_VERSION, type LocalCoreOptions } from './core/local-core.ts';
export { DEFAULT_TUNING, type Tuning } from './core/tuning.ts';
export type { TurnStats } from './core/store.ts';
export type { TextKey, TextTable } from './core/text.ts';
export type { Brain } from './brain/types.ts';
export { Playkit, Kit } from './playkit/index.ts';
export { GameClient, GameError, type GameClientOptions } from './game/client.ts';
export * from './engine/index.ts';
export { CoreFault, FAULT } from './util/errors.ts';
export { webRandom } from './util/ids.ts';
