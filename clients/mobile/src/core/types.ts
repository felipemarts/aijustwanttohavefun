/**
 * The contract types, re-exported from the shared playkit file, plus the few interface-side helpers around them.
 * Only `import type` from the contract: Metro never has to bundle a file outside this project.
 */
import type { Core } from '../../../playkit/core-api';

export type * from '../../../playkit/core-api';

// ── Interface-side helpers ────────────────────────────────────────────────────────────────────────────────────

/** An error from a core, carrying the contract's `CoreError` code. Codes the interface knows are localized. */
export class CoreFailure extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'CoreFailure';
    this.code = code;
    this.status = status;
  }
}

/** Codes produced by this interface's own cores (the Go program and LocalCore may send others). */
export const CODES = {
  /** The program serving this page did not answer (closed, or the machine is asleep). Not the game server. */
  coreUnreachable: 'core_unreachable',
  unauthorized: 'unauthorized',
  /** The on-device core is not in this build yet (the LocalCore stub). Not the contract's `not_available`. */
  notOnDevice: 'not_on_device',
  badResponse: 'bad_response',
} as const;

/**
 * State of the live connection between the interface and its core (interface-side, not in the contract):
 * `RemoteCore` exposes it so the interface can say "reconnecting" instead of showing stale numbers silently.
 */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'unauthorized';

export interface ConnectionAware {
  onConnection(listener: (s: ConnectionStatus) => void): () => void;
}

export function isConnectionAware(c: Core): c is Core & ConnectionAware {
  return typeof (c as Partial<ConnectionAware>).onConnection === 'function';
}
