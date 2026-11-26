import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from './boot';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { MemoryStore } from './store/memory';
import { PgStore } from './store/pg';
import type { Store } from './store/types';

const envFile = join(import.meta.dirname, '..', '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const log = createLogger(config.logLevel);

let store: Store;
if (config.databaseUrl) {
  store = await PgStore.open(config.databaseUrl);
} else {
  log.warn('DATABASE_URL is not set: using the in-memory store. The world is lost when the server stops.');
  store = new MemoryStore();
}

const { app, game, persistence } = await boot({ config, store, logger: log });
game.start();
persistence.start();
await app.listen({ port: config.port, host: '0.0.0.0' });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  try {
    await app.close();
    game.stop();
    await persistence.stop();
    await store.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
