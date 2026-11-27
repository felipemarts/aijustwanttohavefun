## What does this change?

<!-- One or two sentences. Link the issue: Closes #123 -->

## Type

- [ ] Game rule (engine)
- [ ] Content (items, monsters, rooms, quests...)
- [ ] Translation
- [ ] Web / spectator
- [ ] Server / API
- [ ] Tooling / CI
- [ ] Docs

## Checklist

- [ ] `pnpm test`, `pnpm lint` and `pnpm typecheck` pass
- [ ] `pnpm content:check` and `pnpm i18n:report` pass (if content or text changed)
- [ ] New content can be obtained in the game, and new rooms are reachable with exits both ways
- [ ] No visible text hard-coded in code (it goes to `packages/i18n` or `packages/content/i18n`)
- [ ] Balance numbers only in `packages/engine/src/balance.ts`
- [ ] New or changed behaviour has tests
- [ ] New assets listed in `ASSETS.md` with author and license
- [ ] Does this make the game more fun to watch? How?
