import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent } from '@ajwf/content/node';
import type { Catalogs } from '@ajwf/i18n';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app';
import type { Config } from './config';
import { Game, type Clock } from './game';
import { createI18n, loadCatalogs } from './i18n';
import { Persistence } from './persistence';
import type { Store } from './store/types';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS_DIR = join(SERVER_DIR, '..', '..', 'public-docs');
/** Gitignored (`.cache/`). */
export const SPRITES_DIR = join(SERVER_DIR, '.cache', 'sprites');

export type BootOptions = {
  config: Config;
  store: Store;
  logger: Logger;
  now?: Clock;
  catalogs?: Catalogs;
  spritesDir?: string;
  docsDir?: string;
};

export type Server = { app: FastifyInstance; game: Game; persistence: Persistence };

/** Loads content and the saved world, and wires the game, its event consumers and the HTTP app. Starts no timers. */
export async function boot(o: BootOptions): Promise<Server> {
  const game = await Game.boot({ store: o.store, content: loadContent(), now: o.now ?? Date.now, seed: o.config.worldSeed, log: o.logger });
  const persistence = new Persistence(game, o.logger);
  game.subscribe(persistence);
  const i18n = createI18n(o.catalogs ?? loadCatalogs(), (id) => game.state.agents.get(id)?.name);
  const app = buildApp({
    game,
    config: o.config,
    i18n,
    logger: o.logger,
    spritesDir: o.spritesDir ?? SPRITES_DIR,
    docsDir: o.docsDir ?? DOCS_DIR,
  });
  return { app, game, persistence };
}
