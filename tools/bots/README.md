# @ajwf/bots

Scripted (non-LLM) bots: the solo policy used by the engine's level 1 to 5 acceptance test, the simulation, and a
live runner that plays against a real server over HTTP through `@ajwf/sdk`.

## Live bots

Start a server that knows an admin token, then point the bots at it:

```sh
ADMIN_TOKEN=dev-admin pnpm --filter @ajwf/server start
pnpm bots --count 50 --rate 20 --duration 60 --admin-token dev-admin
```

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--url` | `AJWF_URL` | `http://localhost:8710` | Server origin |
| `--count` | `BOTS_COUNT` | 10 | Bots to register |
| `--admin-token` | `ADMIN_TOKEN` | none | Registers them flagged `bot` and claimed, without the 5 per hour registration limit |
| `--rate` | `BOTS_RATE` | 20 | Target total actions per second, across all bots |
| `--seed` | `BOTS_SEED` | time based | Names, classes, languages and personalities |
| `--duration` | `BOTS_DURATION` | until Ctrl+C | Seconds to run |

Each bot registers itself with a generated fantasy name, a random class, `surprise_me` looks and one of the six
launch languages. Keys live in memory only. Bots share the global action rate, and each one also stays under the
server's limit of 60 requests per minute per key (a local token bucket); a 429 is waited out. Every 10 s a status
line shows actions per second, the action mix, refusals and transport errors by code, HTTP statuses and p50/p95
latency; Ctrl+C stops cleanly and prints the summary (a second Ctrl+C quits at once).

A few refusals are normal: a monster another bot just killed (`TARGET_NOT_FOUND`), a resource emptied meanwhile
(`NOT_AVAILABLE_HERE`), chat cooldowns. Transport errors, 401s, 5xx or a growing number of 429s are bugs.

### Personalities

Every bot gets one, from the seed. All of them defer to the solo policy when fallen, fighting or hurt (it drinks
potions, flees, rests at the tavern), and all put on better gear and buy potions in the village.

- **fighter**: the solo policy: hunts monsters of its level where they pay best.
- **gatherer**: mostly gathers, walking to the nearest room with resources left; hunts otherwise.
- **wanderer**: walks random open exits and fights about half of what it meets.
- **chatterbox**: strolls around the village, `say`s short in-character lines in its own language and uses emotes,
  sometimes at agents in the room.

## Other scripts

- `solo.ts`: the solo policy. It decides from a `BotView` (`view.ts`), built from the engine (`viewFromWorld`) or
  from API answers (`viewFromApi` with `/look` or `/act` plus `/me`).
