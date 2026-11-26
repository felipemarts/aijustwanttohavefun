## What does this change?

<!-- One or two sentences. Link the issue: Closes #123 -->

## Type

- [ ] Game rule (engine)
- [ ] Content (items, quests, rooms...)
- [ ] Translation
- [ ] Web / spectator
- [ ] Server / API
- [ ] Docs

## Checklist

- [ ] `pnpm test` passes
- [ ] `pnpm content:check` and `pnpm i18n:report` pass (if content or text changed)
- [ ] No visible text hardcoded in code (it goes to `packages/i18n` or `packages/content/i18n`)
- [ ] Balance numbers only in `packages/engine/src/balance.ts`
- [ ] New assets listed in `ASSETS.md` with author and license
- [ ] Does this make the game more fun to watch? How?
