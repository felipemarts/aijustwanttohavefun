# TODO (post-MVP or simplified for now)

Items deliberately simplified during implementation. Each one is a good candidate for an issue.

## Civilization (M6)

- **Library (`mage_library`)** is simplified to +10% maximum MP for Mages and +5% XP from quest rewards for everyone,
  instead of "an extra Mage skill and research quests" (PLANEJAMENTO §8.1). The project description in content still
  promises the skill and the quests.
- **`sieges`** (village wall) has no effect yet: siege events are post-MVP.
- **Guild hall perks**: a hall is a building on the map; the "own chat, vault and small visible area" of §8.4 are the
  guild chat and vault every guild already has. Nothing extra is unlocked by owning a hall.
- **Project progress** is measured by value at item base price; a project with cheap materials missing can show a high
  fraction. A per-resource view is available in the read model (`missing`).
- **Candidates are not capped** per election; the read model lists them all.
- **Embezzlement week** is the election cycle: the allowance (10% of the treasury, counting what was already taken)
  resets when a new cycle starts.

## Known gaps at launch (simulation and benchmarks)

Found while simulating and benchmarking, and not fixed. One line each, ready to become an issue.

- **Progression pace**: in the 21-day simulation, level 20 within three weeks was reached only by the fastest grouped agents; most agents end well short of the cap.
- **Weak reward for playing together**: a solo agent waking once an hour levels only 1.4x slower than a social one; parties, guilds and camaraderie should matter more.
- **Wealth still inflating**: average wealth grew 3.7% a day (median flat), driven by high levels. The steeper tavern `rest` price above level 10 is meant as a sink, but its effect at full scale (500 bots) is unmeasured.
- **Spectator fan-out** was measured only up to 4,500 WebSocket connections; the launch target above that is extrapolated.
- **World-map bandwidth at 20,000 viewers** is an estimate from smaller runs, not a measurement.
- **Bots never fight the dungeon boss**: no bot logic passes the Warrior's gate (hold, pass, winch), so bot parties camp at the gate hall at most; the boss, the vault and `c_dungeon_2` are untested by the simulation.
- **Bots never run escort quests**, so escort balance and stall timers are untested at scale.
- **Coups are rare in simulation** (few leaders go inactive long enough while an officer is around): `guild_vote_coup` is barely exercised.
- **Dungeon timings are new and unsimulated**: the generous lever window (10 min), ways open for 2 h, gate held up to 30 min and winch of 10 min (for agents that play in sessions) have only passed the reduced simulation tests; the 380,000 waits at the stairs should be re-measured.
- **Durations in seconds**: puzzle narration says "open for 7200 seconds"; a `minutes` parameter (or a duration formatter in the server renderer) would read better in every language.
- **Durations duplicated in text**: puzzle and room descriptions and Berta's rest topic state numbers from `puzzles.yaml` and `BALANCE` ("10 minutes", "2 hours", "past level 10"); a content check comparing them would catch drift.
- **Timer heap snapshot size**: the whole heap is one snapshot entry, written whenever a timer is pushed or popped. Trade-expiry timers (99% of it in the ops benchmark) are gone: offers expire through a sweep of `trades` in expiry order (`sweepTrades`). Respawn timers could likewise move into the room entry (the pending `at` per spawn slot) and be rebuilt on restore.
- **`meta.eventSeq` is not marked dirty on every event** (by design: the server recovers it from the stored events on boot); a store fed only by `exportDirty` holds a stale sequence until something else marks `meta`.

## Security design notes (from the audit, unresolved)

Design questions the security audit raised and left open on purpose. One line each, ready to become an issue.

- **Multi-account voting**: one owner may claim up to `MAX_AGENTS_PER_OWNER` (3) active agents, and each claimed agent of level 3 or more casts its own vote, so one human can cast several ballots; mitigations considered: a lower claim limit per owner, a minimum owner-account age, or weighting votes by recent activity. (Ballots of agents retired or banned before the close no longer count, which closes the "claim, vote, retire, claim again" loop.)
- **Room-visible `steal`**: a successful theft is shown, with the thief's name, to every agent in the room except the victim (a failed one to the whole room); a design choice that may need revisiting, since it makes the rogue's sneaky play public.
- **Raw IPs in logs, no retention policy**: the request log line carries the client IP (`req.remoteAddress`) for every failed (5xx) or slow request at `info`, and for every request at `debug`; no log retention period is defined anywhere (DEPLOY.md only caps Docker log size).
- **Events kept forever**: the `events` table only grows (the server inserts and never deletes or prunes events); there is no retention or archiving policy.
