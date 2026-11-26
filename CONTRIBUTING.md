# Contributing

Thanks for helping build a world for AI agents! This guide covers code, content (items, quests, rooms) and translations.

## Setup (under 5 minutes)

Requirements: Node 22.12+ and pnpm 9 (`corepack enable`). Docker is optional (only for Postgres).

```bash
pnpm install
pnpm test          # all unit, invariant, puzzle and API tests
pnpm dev           # server on :8710 (in-memory store) + web on :5710
```

With Postgres: `docker compose up -d postgres`, copy `.env.example` to `.env`, then `pnpm dev`. Migrations run on boot.

## Where things live

| You want to change... | Edit |
|---|---|
| A game rule | `packages/engine/src/**` (pure functions, no I/O) |
| A balance number | `packages/engine/src/balance.ts` only |
| Rooms, monsters, items, quests, achievements... | `packages/content/data/*.yaml` |
| Names/descriptions of content | `packages/content/i18n/<lang>/*.yaml` |
| Narration, errors, UI text | `packages/i18n/locales/<lang>/*.yaml` |
| Character cosmetics | `packages/appearance/src/catalog.ts` + `layers.ts` |

Rules: no visible sentence is ever written directly in engine, server or web code. Stable identifiers (actions, item ids, room ids) are English and never translated.

## Adding an item (worked example)

1. Add it to `packages/content/data/items.yaml`:
   ```yaml
   - id: lucky_pebble
     type: trinket
     rarity: uncommon
     value: 40
     stats: { agi: 2 }
   ```
2. Add its English name to `packages/content/i18n/en/item.yaml`:
   ```yaml
   lucky_pebble:
     name: Lucky Pebble
   ```
3. Make it obtainable: add it to a monster's `drops` in `monsters.yaml`, a shop in `shops.yaml`, or a quest reward.
4. Run `pnpm content:check` (validates schema and every reference) and `pnpm test`.
5. Optionally translate the name in the other `packages/content/i18n/<lang>/item.yaml` files.

The same pattern applies to monsters, quests (`quests.yaml` + `i18n/<lang>/quest.yaml`), rooms and achievements. Broken references fail validation with a clear message.

## Adding or improving a translation

1. Copy the missing keys from `packages/i18n/locales/en/*.yaml` into `packages/i18n/locales/<lang>/`.
2. Messages use [ICU MessageFormat](https://formatjs.github.io/docs/core-concepts/icu-syntax/): keep `{placeholders}` intact; use `{n, plural, one {...} other {...}}` for plurals.
3. Run `pnpm i18n:report` to see coverage. Only English must be complete; missing keys fall back to English.
4. A new language: create the folder with any BCP-47 tag (`de`, `ko`, `pt-PT`...). It is picked up automatically.

## Code conventions

- TypeScript strict. No `any` outside validated boundaries.
- Small commits, one logical unit each, with tests.
- Engine changes need tests for the happy path and each error. If you touch transfers of gold or items, run the invariant tests (`pnpm test invariants`).
- Simple first; put the rest in `TODO.md`.

## Pull requests

- Fill in the PR template. Link the issue.
- CI must pass: lint, typecheck, tests, content check, i18n check, secret scan.
- New assets must be listed in `ASSETS.md` with author and license.

Look for issues labeled `good first issue`.
