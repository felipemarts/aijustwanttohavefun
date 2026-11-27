import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent } from '@ajwf/content/node';
import type { Catalogs } from '@ajwf/i18n';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app';
import { Census } from './census';
import { Chronicle } from './civic/chronicle';
import type { Config } from './config';
import { Game, type Clock } from './game';
import { createI18n, loadCatalogs } from './i18n';
import { Metrics } from './metrics';
import { Persistence } from './persistence';
import { Broadcaster } from './spectate/broadcaster';
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

export type Server = { app: FastifyInstance; game: Game; persistence: Persistence; spectators: Broadcaster; metrics: Metrics; census: Census; chronicle: Chronicle };

/** Loads content and the saved world, and wires the game, its event consumers and the HTTP app. Starts no timers. */
export async function boot(o: BootOptions): Promise<Server> {
  const game = await Game.boot({ store: o.store, content: loadContent(), now: o.now ?? Date.now, seed: o.config.worldSeed, log: o.logger });
  const persistence = new Persistence(game, o.logger);
  game.subscribe(persistence);
  const i18n = createI18n(o.catalogs ?? loadCatalogs(), (id) => game.state.agents.get(id)?.name);
  const metrics = new Metrics();
  const census = new Census(game.state);
  const chronicle = new Chronicle({ state: game.state, store: o.store, census, log: o.logger, now: game.now, seed: o.config.worldSeed });
  await chronicle.hydrate();
  game.subscribe(chronicle);
  game.onDayRollover((now) => chronicle.rollover(now));
  const spectators = new Broadcaster({
    state: game.state,
    now: game.now,
    metrics,
    census,
    log: o.logger,
    text: (key, params) => i18n.t('en', key, params),
    maxConnections: o.config.wsMaxConnections,
    maxPerIp: o.config.wsMaxPerIp,
  });
  game.subscribe(spectators);
  chronicle.onHighlight((h) => spectators.pushHighlight(h));
  const app = buildApp({
    game,
    config: o.config,
    i18n,
    logger: o.logger,
    spritesDir: o.spritesDir ?? SPRITES_DIR,
    docsDir: o.docsDir ?? DOCS_DIR,
    spectators,
    metrics,
    census,
    chronicle,
  });
  metrics.setSources({
    now: game.now,
    agentsRegistered: () => census.counts(game.now()).population,
    agentsOnline: () => census.online(game.now()),
    agentsOnMap: () => spectators.onMap,
    spectators: () => spectators.connections,
    wsWireBytes: () => spectators.wireBytes(),
    persistenceBuffered: () => persistence.buffered,
  });
  return { app, game, persistence, spectators, metrics, census, chronicle };
}
