# Handoff: implementing PLANEJAMENTO.md

Read `PLANEJAMENTO.md` first; it is the spec. This file covers what is already done, the decisions made so far, and what comes next.

## Status

| Milestone | Status |
|---|---|
| M0: Foundation | **Done**, commit `33c15c7`. `pnpm install && pnpm test && pnpm dev` works. |
| M1: Engine core and appearance | **Partial.** Appearance package is done (commit `ab9caf7`). Content is about 40% written and **uncommitted**. The engine has not been started. |
| M2 to M8 | Not started. |

## Environment notes (read before running anything)

- Windows with Git Bash and PowerShell, Node 22.22, pnpm 9.15, Docker available.
- **Ports:** the server uses **8710** and the web app uses **5710**. Ports 8080 and 5173/5174 belong to Docker containers from another of the user's projects. Don't use them, and don't stop those containers.
- **Never run `taskkill /IM node.exe`.** To stop dev servers, kill by PID only (`netstat -ano | grep 8710`, then `taskkill //F //T //PID <pid>`). On Windows, stopping a background `pnpm dev` leaves orphaned node processes holding 8710/5710.
- Postgres: `docker compose up -d postgres` (user, password and database are all `ajwf`). Migrations are applied with `DATABASE_URL=postgres://ajwf:ajwf@localhost:5432/ajwf pnpm db:migrate`. They have already been applied once locally.
- **Tool-input gotcha:** writing `\uXXXX` escapes for non-ASCII characters in Write/Bash tool inputs gets decoded into literal characters. To keep escapes in source, build them in code (see how `INVISIBLE` was generated in `packages/shared/src/text.ts`). For YAML or other content with apostrophes or quotes, prefer the Write tool over Bash heredocs; one heredoc failed silently.

## Decisions taken (all within the spec)

- **TypeScript 6.0.3, not 7.0.** typescript-eslint 8.74 requires TS < 6.1.
- **Library versions:** Zod 4, Vitest 5, Vite 8, React 19, PixiJS 8, Fastify 5, drizzle-orm 0.45 / drizzle-kit 0.31.
- **No build step for internal packages.** Every package's `exports` points to `./src/*.ts`, the server runs with `tsx`, and Vite and Vitest consume the TS directly. Type checking is `pnpm typecheck` (`tsc -p` in each package, `noEmit`).
- **Single root `vitest.config.ts`.** Tests live at `{apps,packages,tools}/*/src/**/*.test.ts`.
- **Art is original procedural pixel art (CC0), drawn in code.** No LPC or Kenney files are used, which avoids per-file attribution. This is recorded in `ASSETS.md`, with LPC and Kenney listed as candidates.
- **Sprite format:** 4 frames of 20×28 px (idle, left step, right step, blink), so each sheet is 80×28 PNG.
- **Narration:** the engine returns `Msg = { k: i18nKey, p?: params }`. Params can reference entities as `@room:id`, `@item:id`, `@mon:id`, `@npc:id`, `@agent:id`, `@skill:id`, `@quest:id`, `@proj:id`, `@ach:id`, `@title:id`, `@emote:id`, `@dir:id`, `@class:id`, `@prof:id`, `@res:id`, `@recipe:id`, `@zone:id` (helpers are in `shared/src/events.ts`). `I18n.resolveParams` turns them into `content.<kind>.<id>.name`. `@agent:` needs a custom resolver on the server, from id to name.
- **Content translations:** they live in `packages/content/i18n/<lang>/<kind>.yaml` as `{ <id>: { name, desc } }` and load as `content.<kind>.<id>.name|desc`. The kinds are zone, room, mon, item, recipe, prof, npc, quest, ach, title, class, skill, emote, proj, puzzle. `requiredContentKeys()` lists the English keys that must exist, and `pnpm content:check` enforces them.
- **Server without `DATABASE_URL`** should fall back to an in-memory store, so `pnpm dev` works on a clean machine (not yet implemented). `.env.example` has `DEV_LOGIN=1`, meant to enable a fake OAuth login for local development.
- **Extra actions beyond spec table 11.4** are already in the zod schemas in `shared/src/schemas.ts`: `release` (respawn while fallen), `enchant` (Mage), `choose_profession`, `party_say`, `guild_say`, `guild_promote`, `guild_build_hall`, `party_give_loot`, `market_list`, `quest_list`, `inventory`, `set_title`, `set_language`, and the `mayor_*` actions (priority, tax, fund, bounty, embezzle).
- **Death:** the agent becomes "fallen" for a few minutes so a Cleric can `revive` them in place. Otherwise `release`, or the timeout, sends them to the temple with the 10% gold loss. While fallen, actions return the `DEAD` error.

## What exists, by package

- `packages/shared` (MIT): constants (languages, error codes, classes, limits), zod schemas for register and every action, `GameEvent`, the spectator WebSocket protocol types (`protocol.ts`), `sanitizeAgentText` (removes invisible and control characters, links and emails, redacts keys), name validation (NFKC normalization, a lookalike-character "skeleton", a reserved list), a multilingual word filter, and a seeded RNG plus `hashString`. Tested.
- `packages/i18n`: `I18n` class (ICU via intl-messageformat, fallback to English, `resolveLang` for any BCP-47 tag, reference resolution), the YAML loader in `./node`, and a coverage report (`pnpm i18n:report`). The 6 locale folders exist. `en` has `ui.yaml` and `appearance.yaml`; the other languages have only `ui.yaml`. Tested.
- `packages/appearance`: catalog (6 species × 6 skins, 15 hair styles, 12 hair colors, 21 hats, 22 tops, 10 bottoms, 11 cloaks, 16 accessories, 17 dyes; options marked `starter:false` come from items only), `OptionsTokenStore` (5 options per layer, 30-minute TTL), `validateChoice`, `ensureUnique`, `describeAppearance`, and `sprite.ts` (`renderSpritePng`, `renderPortraitPng`). The tests include "1,000 `surprise_me` registrations give 1,000 distinct appearances".
- `packages/content`: zod schemas for every file in spec §16.3, plus `buildContent()`, which checks references and that every room is reachable from `village.square`. `./node` loads the YAML and the content translations. `pnpm content:check` exists.
- `apps/server`: the complete Drizzle schema for spec §16.2 (plus a `reports` table), migration `drizzle/0000_*.sql`, and `migrate.ts`. `main.ts` is a placeholder that only serves `/healthz`.
- `apps/web`: Vite + React skeleton with a dev proxy to 8710 for `/api`, `/ws`, `/sprites`, `/skill*` and similar paths. `main.tsx` is a placeholder.
- `packages/engine`, `sdk`, `mcp`, `tools/*`: only `package.json`, `tsconfig.json` and an empty `export {}`. Their dependencies are already declared.
- Repo files: `LICENSE` (AGPL-3.0), MIT `LICENSE` files in shared, sdk, mcp and example-agent, `README.md` (still the stub), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `ASSETS.md`, `TODO.md` (empty), `.github` with CI (lint, typecheck, content check, i18n report, test, web build, `bench --ci`, gitleaks) and issue/PR templates.

## Uncommitted work in progress (packages/content)

- `src/schema.ts`: gates now accept `requires: boss`, and puzzles have `winch_room`.
- `src/index.ts`: validates boss gates.
- `data/zones.yaml`: done.
- `data/rooms.yaml`: **done**, 57 rooms. The grid convention is that cell (cx, cy) gets rect `[cx*12, cy*10, 10, 8]`. The bridge gate is between `village.river_bank` and `mines.lower_gate`. The dungeon gates are a party gate on stairs `down`, then levers, trap, seal, the gate with a winch, and a boss gate to the vault.
- `data/monsters.yaml`: done, 23 monsters including the boss `the_hollow_regent` and the world boss `ancient_colossus`.
- `data/items.yaml`: done, about 100 items.
- `data/recipes.yaml`: done, 46 recipes.
- **Still missing**, so `content:check` currently fails:
  - `professions.yaml`: was about to write `blacksmith→forge`, `alchemist→alchemy`, `tailor→loom`, `cook→kitchen`.
  - `npcs.yaml`: planned NPCs are `olga` (square: tutorial giver and small shop), `gunnar` (smithy shop), `mirela` (alchemist shop), `tomas` (tailor shop), `berta` (tavern innkeeper and quests), `sister_ilse` (temple priest), `clerk_aldo` (town hall clerk), `registrar_vey` (guild hall), `sergeant_holt` (training yard trainer), `guard_east` and `guard_south` (guards), `ranger_fen` (forest.edge), `foreman_brakka` (mines.entrance), `hag_morwen` (swamp.witch_hut, rare herb shop), `scholar_ines` (ruins.road), `merchant_bram` (market, escort).
  - `shops.yaml`.
  - `quests.yaml`: planned as 20 tutorial quests t01 to t20 covering every system; 12 dailies, at least one of them social (trade, party, help_newbie, contribute); 5 two-step group chains (bandits, hag with multi-profession delivery, mines golems with pot and stew, dungeon levers then boss, civic contribute then vote); 2 escorts with `merchant_bram`; 2 side quests.
  - `achievements.yaml`: about 50 achievements on stat counters, including world-first ones.
  - `titles.yaml`.
  - `classes.yaml`.
  - `skills.yaml`, with skills unlocked at levels 1, 5, 10 and 15:
    - Warrior: power_strike, taunt, shield_wall, whirlwind
    - Mage: firebolt, frost_nova, arcane_shield, meteor
    - Rogue: backstab, poison_blade, vanish, shadowstep
    - Cleric: heal, revive, bless, sanctuary
  - `emotes.yaml`.
  - `projects.yaml`, with these sites and prerequisites:
    - bridge at river_bank
    - watchtower at plot_ne
    - inn_expansion at the tavern
    - library at plot_nw, requires watchtower
    - covered_market at the market, requires inn_expansion
    - arena at plot_sw, requires bridge
    - wall at south_gate, requires arena and watchtower
    - statue at the square, requires bridge, watchtower and inn_expansion
    - plots plot_far, plot_se and plot_s stay free for guild halls
  - `puzzles.yaml`: dungeon_levers, dungeon_trap, dungeon_chest (lock), dungeon_seal, dungeon_gate (with `winch_room: dungeon.boss_lair`), and a vault lock.
  - `gazette_templates.yaml`.
  - All the English content names in `packages/content/i18n/en/*.yaml`.
- Planned world boss spawn room: `hills.pass` (to go in `balance.ts`).

## Balance sketch (to go in `packages/engine/src/balance.ts`)

- AP: maximum 240, regenerating 1 every 120 s. HP, MP and AP regenerate lazily from timestamps.
- Attack = weapon atk + primary stat. Defense = armor def + VIT × 0.5. HP = 40 + VIT × 8 + level × 10. MP = 20 + INT × 5.
- Damage formula and XP curve are as in the spec.
- Party XP: the pool is base × (1 + 0.1 × (n − 1)), split evenly.
- The M4 acceptance test needs groups to level at least 1.8× faster than solo players. Expect to tune this with elite and dungeon XP, camaraderie, and the fact that solo players take all the retaliation damage.

## Next steps, in order

1. Finish the content files and the English content i18n, then make `pnpm content:check` pass. Commit.
2. **Engine (M1):** a pure `applyAction(state, cmd, {now, rng}) → {result, events}`. It needs:
   - Indexed state: agents by id and by normalized name, plus per-room sets of agents, monsters and items.
   - A timer heap and a `tick(state, now)`.
   - Movement, look and observe, AP, classes, stats, XP and levels, PvE combat, death and fallen state, inventory and equipment, shops, gather with limited stock, and basic crafting.
   - Per-agent inbox ring buffers for `/events`.
   - Dirty-entity tracking for snapshots.
   - Invariant tests.
   - A bot that levels from 1 to 5 using only `applyAction`.
3. English narration, error and hint keys in `packages/i18n/locales/en/`, plus a test that every engine key exists in `en`. Translate to the other 5 languages; this can be delegated.
4. Then M2 through M8 as described in the spec (§17).

Small commits, each with its tests, and the commit trailer from the system prompt.
