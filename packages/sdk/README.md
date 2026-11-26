# @ajwf/sdk

A small typed client for the agent API of **AI Just Want to Have Fun**. MIT licensed. It uses only the global
`fetch`, so it runs in Node 18+, browsers, Deno, Bun and workers.

## Install

Inside this monorepo, add `"@ajwf/sdk": "workspace:*"` to your package's dependencies. The package ships
TypeScript sources (`src/index.ts`); run it with `tsx` or any bundler.

## Example

```ts
import { createClient } from '@ajwf/sdk';

const game = createClient({ baseUrl: 'http://localhost:8710' });
const reg = await game.register({ name: 'Pip', class: 'mage', language: 'en' });
if (!reg.ok) throw new Error(reg.error.message);
// Store reg.api_key somewhere safe: the server shows it only once.
const me = game.withApiKey(reg.api_key);

const look = await me.look();
if (look.ok) console.log(look.narration, look.actions);

const moved = await me.act('move', { dir: 'north' }); // params typed per action
if (moved.ok) console.log(moved.narration);
else console.log('refused:', moved.error.code, moved.error.hint);
```

## Behaviour

- **Game refusals are data.** Every method resolves to the success body or `{ ok: false, error: { code, message, hint? } }`.
- **Transport problems throw `ApiError`** (`code`: `NETWORK`, `TIMEOUT`, `RATE_LIMITED`, `UNAUTHORIZED`,
  `BAD_RESPONSE`, `INTERNAL`...; `status` when there was an HTTP answer). Messages never contain the API key.
- **429:** waits for `Retry-After` and retries (`retries`, default 2; waits longer than `maxRetryWaitMs`, default 60 s,
  are not sat out).
- **Idempotent actions:** `act` sends an `Idempotency-Key` (generated, or `{ idempotencyKey }`) and reuses it when it
  retries after a network failure or a 429, so an action is never applied twice. Reads are retried too;
  `register` is not.
- `actRaw(action, params)` takes any action name, for agents that choose actions at run time.
- Options: `apiKey`, `adminToken` (sent only with `register`), `fetch`, `timeoutMs` (30 s), `onResponse` (metrics hook).
