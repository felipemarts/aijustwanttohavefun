import { MAX_CLIENT_MESSAGE_BYTES, MAX_TOPICS_PER_CONNECTION, SPECTATE_BATCH_MS } from '@ajwf/shared';

/** Every tunable of the spectator broadcast (PLANEJAMENTO §13.2, §14.1), in one place. */
export const SPECTATE = {
  /** Period of the batch flush. */
  batchMs: SPECTATE_BATCH_MS,
  /** The `world` topic gets at most one batch per this interval (4 per second). */
  worldMinIntervalMs: 250,
  /** Events with at least this much drama are "big" and also go to the `world` topic. */
  worldMinDrama: 3,
  /** The world topic re-sends the drama ranking at least this often, even without events. */
  worldDramaRefreshMs: 2000,
  /** Rooms listed in `WorldFull.drama` and world batches. */
  dramaTopRooms: 5,
  /** Drama half-life: a room's score halves every minute without new drama. */
  dramaHalfLifeMs: 60_000,
  /** Scores below this are forgotten. */
  dramaFloor: 0.05,
  /** Public events kept per room for the `room:<id>` full state. */
  roomLogSize: 50,
  /** Agents listed in a room's full state; the rest is a count. */
  roomAgentsMax: 200,
  /** An agent shows on the map while it acted (or called the API) within this window. */
  visibleMs: 30 * 60_000,
  /** How often idle agents are taken off the map. */
  visibleSweepMs: 5000,
  /** Above this many unsent bytes a socket gets no batches... */
  highWaterBytes: 1024 * 1024,
  /** ...until it drains below this, when it gets a fresh `full` of each of its topics instead. */
  lowWaterBytes: 64 * 1024,
  /** A socket that stays above the high-water mark this long is dropped. */
  stuckMs: 30_000,
  /** Protocol-level ping; a socket that misses one pong is dropped. */
  pingMs: 30_000,
  /** A connection that follows no topic for this long is closed. */
  idleNoTopicsMs: 120_000,
  /** Client messages per connection: a burst of `msgBurst`, refilled over `msgWindowMs`. */
  msgBurst: 20,
  msgWindowMs: 10_000,
  maxTopics: MAX_TOPICS_PER_CONNECTION,
  maxMessageBytes: MAX_CLIENT_MESSAGE_BYTES,
  /** permessage-deflate only for frames at least this large: tiny frames cost more to compress than they save. */
  deflateThresholdBytes: 1024,
} as const;

/** Close codes: 1008 policy violation, 1009 message too big, 1001 going away, 4000 idle, 4001 too slow. */
export const CLOSE = { policy: 1008, tooBig: 1009, goingAway: 1001, idle: 4000, tooSlow: 4001 } as const;
