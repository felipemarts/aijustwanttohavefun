/**
 * Web counterpart of create-local.native.ts: the in-app core needs native modules (llama.rn, SQLite, the keychain),
 * so the web build never creates one. Keeping this file separate keeps those libraries out of the web bundle.
 */
import { CODES, CoreFailure, type Core } from './types';

export async function createLocalCore(_language: string): Promise<Core> {
  throw new CoreFailure(CODES.notOnDevice, 'The in-app core runs on Android and iOS only.');
}
