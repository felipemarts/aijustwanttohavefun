# Handoff: state of the implementation of PLANEJAMENTO.md

`PLANEJAMENTO.md` is the spec. This file says what is built, what was verified and how, where the implementation departs from the spec, and what is left. `TODO.md` lists the known gaps one line each; `docs/DEPLOY.md` covers production; `docs/ISSUES.md` has 26 starter issues.

Everything is committed on `main`, locally. **Nothing has been pushed and nothing is deployed.**

## Status

All milestones M0 to M8 are implemented. The table says what each acceptance test was checked against.

| Milestone | State | How it was accepted | Not verified |
|---|---|---|---|
| M0 Foundation | Done | `pnpm install && pnpm test && pnpm dev` | |
| M1 Engine and appearance | Done | A bot levels 1 to 5 in every class through `applyAction` alone; fuzzers hold the invariants | |
| M2 Server and agent API | Done | Two real LLM players (one English, one Portuguese) registered from the one-line instruction and played 40+ actions each | |
| M3 Spectator web | Done | 60 fps with 500 agents on the map, measured in a desktop test browser | A real phone: only a phone-sized viewport was tested |
| M4 Social and dungeon | Done | Simulation: grouped agents reach level 10 1.92x faster than solo ones | Bots cannot pass the Warrior's gate, so the boss and the vault are covered by unit tests only |
| M5 Trust and PvP | Done | Simulation with traitors: no PvP or theft against agents below level 8 | |
| M6 Civilization | Done | Simulation: 3 projects built, a full election, 7 gazettes in 7 simulated days | |
| M7 Chronicle and owners | Done | Tests for highlights, gazette, secrets, OAuth, claim flow, Web Push, share cards | Link previews on X and WhatsApp, which need a public domain |
| M8 Launch readiness | Code done | MCP server, benchmarks, Docker image, CI, deploy guide, independent security audit and its fixes | The production deploy itself; 20,000 spectators (measured to 4,500, the rest extrapolated) |

Checks at the last full run: typecheck and eslint clean, 907 tests passing and 3 skipped (the Postgres store tests, which need `DATABASE_URL`), `content:check` clean, web build clean, six languages at 100%.

## Added after the milestones

- **Wishing fountain.** Action `wish` in the village square: 1 to 10 gold into a pot kept in world state, an optional wish text, claimed agents only, once a minute. Hidden jackpot: once the pot holds 25 gold, each coin has a 0.2% chance of returning the whole pot (`BALANCE.fountain`); nothing told to agents states it. The roll uses `ActionCtx.luck`, an unpredictable source the server passes, not the shared seeded generator. Other agents are told a wish was made, not its text; spectators read the text.
- **Director mode rebuilt** (`apps/web/src/map/director.ts`, `apps/web/src/data/delay.ts`, `apps/web/src/data/scout.ts`, `apps/web/src/ui/StarCard.tsx`). The camera follows one agent, the star. While the director is on, the screen plays 30 s late (the lag builds over the first 90 s; any manual pan, zoom or click flushes it and goes live), and an undelayed "scout" uses those 30 s to cut to an agent a few seconds before their moment. Interest is scored per agent on the server from spectator-visible events only (`packages/shared/src/interest.ts`, sent as increments in world batches). A lower-third card shows who the star is and what they are doing; big moments get a banner.
- **Playtest fixes.** Three rounds of five Haiku players in Portuguese (about 100 actions each, with 20 scripted bots) rated the game 6 to 7 out of 10 each time. What they liked was the other agents; what hurt was logistics. Fixed from their reports: tutorial wood, refusal texts, party invite notices, open trade offers in `/me`, a stale NPC line.

What the playtests still say, unfixed and mostly balance:

- Monsters and gatherables near the village are fought over; kills and herbs are taken by others between two calls, and the daily herb run is not doable alone in a busy world.
- Parties scatter: nothing keeps members together, and accepting an invite needs the same room (see `TODO.md`).
- Trade offers go unanswered, so the daily trade quest stalls.
- One player reported about ten wolf kills with no pelt (the drop chance is 40%); not reproduced, and worth checking who receives drops when several agents hit the same monster.
- In those sessions nobody passed level 2 in 120 actions.

## Environment (read before running anything)

- macOS, Node 22 through nvm. The default shell Node is v20, so prefix commands with `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" &&`.
- **Ports:** server **8710**, web **5710**. Ports 8080 and 5173/5174 belong to Docker containers of another project of the owner. Do not use them and do not stop those containers.
- Stop dev servers by PID only (`lsof -ti :8710`, then `kill <pid>`). Never kill every `node` process.
- Without `DATABASE_URL` the server uses an in-memory store, so `pnpm dev` works on a clean machine. With Postgres: `docker compose up -d postgres`, credentials in `.env.example`.
- This machine's terminal rewrites command output through a filter that hides Vitest summaries. Run `npx vitest run --reporter=json --outputFile=.vitest/all.json` and read the totals from the JSON, and trust exit codes.
- Playwright screenshots must be saved under the repo (`.playwright-mcp/`, gitignored), not outside it.

## Commands

| What | Command |
|---|---|
| Everything a commit must pass | `pnpm typecheck && pnpm lint && pnpm test && pnpm content:check && pnpm i18n:report && pnpm --filter @ajwf/web build` |
| Server and web together | `pnpm dev`, then http://localhost:5710 |
| Web with a simulated world, no server | http://localhost:5710/?mock=1 (also `?stress=500`, `?built=all`, `?debug=1`) |
| Scripted bots against a running server | `ADMIN_TOKEN=dev-admin pnpm bots --count 30 --duration 300` (the server needs the same `ADMIN_TOKEN`) |
| In-process simulation | `pnpm sim` (see `tools/bots/README.md`; `--scenario civilization` for M6) |
| Benchmarks | `pnpm bench` (`--ci` compares against `tools/bench/results/ci-baseline.json`) |

## Architecture in one page

- **No build step.** Packages export `./src/*.ts`; the server runs with `tsx`; Vite and Vitest read TypeScript directly.
- **`packages/engine` is pure.** `applyAction(state, {agentId, action, params}, {now, rng})` returns `{result, events}` and never throws. Handlers validate first with `fail(CODE, 'slug', params)` and only then mutate; a refusal leaves the world byte-identical, which the fuzzers assert. All tuning is in `balance.ts`. State is plain JSON with dirty keys for snapshots, a timer heap, and regeneration computed from timestamps.
- **Text is keys, not strings.** The engine emits `{k, p}` messages; the server renders them in the agent's language. `packages/engine/src/i18n-keys.test.ts` scans the engine source and requires English text for every key. Content text lives in `packages/content/i18n/<lang>/`, interface and narration in `packages/i18n/locales/<lang>/`.
- **`apps/server`** wraps the engine: Fastify, snapshots every 5 s, hashed API keys and claim tokens, rate limits, idempotency keys, token budgets on `/look` and `/act`, the spectator WebSocket, the chronicle, owner accounts (OAuth with PKCE), Web Push, share cards, admin routes, and MCP at `/mcp`.
- **`apps/web`** keeps its store outside React; the map is PixiJS with procedural CC0 pixel art drawn in code.
- **Agent-written text** is only ever delivered under `untrusted_text`, after `sanitizeAgentText`.

## Where the implementation departs from the spec

These were decided during implementation and are waiting for the owner to confirm or reverse.

- **Party XP is not divided.** Spec §6.4 divides the pool among members, and with that rule the M4 acceptance (groups 1.8x faster) could not be met. Each member now gets the side's share times `1 + 0.1 × (n − 1)`.
- **The tutorial no longer requires voting**, since an election may not be open when a new agent reaches that step.
- **Dungeon timings are wide** (lever window 10 min, ways open 2 h, gate held up to 30 min) so that agents playing in sessions can coordinate.
- **Project costs were raised** 12x, 20x and 30x by tier, and tavern `rest` costs more above level 10, both as gold sinks.
- **Kills in self-defence give no Infamy.**
- **Election totals are sealed until the close**, and ballots of agents retired or banned before the close are dropped. The spec showed live totals; the audit showed they exposed each vote and enabled vote farming.
- **Guild names are limited to 3 words** and names resembling instructions or authority are refused, because names are narrated to every agent in the room.
- **Extra server switches** not in the spec: `CLIENT_IP_HEADER` (which header carries the client IP behind a proxy) and `MIGRATE_ON_BOOT=0` (run the server with a database role that cannot alter the schema).

## Security

An independent audit covered 14 areas. Its one critical finding: `market_buy` with the order id `__proto__` turned an agent's gold into `NaN`, after which every balance check passed. It is fixed in three layers: ids are refused at the API boundary (`isPlainKey`), every record lookup by an outside key reads own properties only (`own`, `hasOwnKey` in `packages/shared/src/own.ts`), and all gold and item movements go through `packages/engine/src/ledger.ts`, which fails closed on anything that is not a safe non-negative integer. `fuzz.hostile.test.ts` feeds the seven `Object.prototype` names and hostile numbers into every parameter of every action.

**The rule for new code:** never index a record with a key that came from a parameter, a bundle or a snapshot using `[]` or `in`; use `own` and `hasOwnKey`. Move gold and items only through the ledger helpers.

Risks left open on purpose (also in `TODO.md`):

- One human with several free OAuth accounts gets 3 votes per account. Only a real cost limits this (verified accounts, account age).
- The link and secret filter in chat is a heuristic; `evil[.]com` passes. The real defence is `untrusted_text` plus the rules in `skill.md`.
- Request logs carry client IPs and the `events` table grows forever; no retention policy is defined.

## What is left

Needs the owner:

1. Confirm or reverse the departures listed above, the party XP rule first.
   Also open: whether party invites may be accepted from any room, and whether parties should be able to follow their leader.
2. Production deploy: a domain, a cloud account, and GitHub and Google OAuth apps (`docs/DEPLOY.md`). On Fly, check that `CLIENT_IP_HEADER=Fly-Client-IP` yields real client addresses before launch, since every per-IP limit depends on it.
3. A real contact address in `CODE_OF_CONDUCT.md`, and confirmation of the repository URL used across the docs (`github.com/aijustwanttohavefun/aijustwanttohavefun`).
4. Review of Japanese and Simplified Chinese by native speakers; both were machine-translated.

Engineering, in rough priority:

1. Measure the spectator fan-out at the launch target; the estimate is about 530 Mbit/s at 20,000 viewers.
2. Teach the bots the dungeon gate and escort quests, then re-run the 21-day simulation; those two systems are untested at scale.
3. Progression pace and the reward for playing together (`TODO.md`, "Known gaps at launch").
4. Migrate to version 2 of the MCP SDK after launch.

## Working rules the owner set

- Small commits, each with its tests, ending with the co-author trailer.
- When delegating to subagents: the lead session does management, architecture, security and design; Opus-class agents implement; Sonnet-class agents write translations, dialogue, story and quests. Always name the model explicitly.
- Never more than 10 agents running at once.
- Commit locally; push or deploy only when asked.
