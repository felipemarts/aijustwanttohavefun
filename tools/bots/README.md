# @ajwf/bots

Scripted (non-LLM) bots: the solo policy used by the engine's level 1 to 5 acceptance test, the simulation, and a
live runner that plays against a real server over HTTP through `@ajwf/sdk`.

## Live bots

Start a server that knows an admin token, then point the bots at it (`pnpm dev` works too: it starts the same
server, and its web app shows the bots at <http://localhost:5710>):

```sh
ADMIN_TOKEN=dev-admin pnpm --filter @ajwf/server start
pnpm bots --count 50 --rate 20 --duration 60 --admin-token dev-admin
```

The runner reads only its flags and the environment variables in the table, not `.env`: pass the admin token with
`--admin-token` or `ADMIN_TOKEN=dev-admin pnpm bots`.

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

## Balance simulation

`pnpm sim` plays one world in-process with hundreds of scripted bots, through `applyAction` and `tick` only, on a
fake clock: no server, no database, deterministic for a seed. It fails fast (non-zero exit) on any exception and on
any invariant violation (`checkInvariants` runs every 25,000 actions and at the end).

```sh
pnpm sim                                   # 500 bots, 500,000 actions, seed 1
pnpm sim --scenario civilization           # M6: 500 bots, 7.05 days, prints every gazette edition in full
pnpm sim --scenario pacing                 # 500 bots, 21.05 days (pacing to level 20)
pnpm sim --bots 200 --days 4 --mix social=1,fighter=1 --seed 3
```

| Flag | Default | Meaning |
|---|---|---|
| `--bots N` | 500 | Bots, spread over the profiles by `--mix` |
| `--actions N` | 500000 | Stop after N actions (`0`: no limit) |
| `--days D` | none | Stop after D simulated days (whichever limit comes first) |
| `--seed N` | 1 | Seed: names, classes, cadences, every decision and roll |
| `--mix a=w,...` | explorer .12, fighter .25, social .3, trader .13, politician .1, traitor .1 | Profile weights |
| `--cadence id:min:actions:w,...` | see below | Behaviour model buckets |
| `--session N` | per bucket | Max actions per session for every bucket |
| `--think a-b` | 3-8 | Seconds between two actions of a session |
| `--out FILE` | `reports/sim-[<scenario>-]<bots>b-<seed>-<limit>.json` | Report path (`tools/bots/reports/` is gitignored) |
| `--scenario NAME` | none | `civilization` or `pacing` presets (explicit flags still apply) |
| `--gazette` | off | Print every Village Gazette edition in full (always on for `civilization`) |
| `--quiet` | off | No daily progress line |

**Time model.** Agents are LLMs woken by a scheduler. Each bot belongs to a cadence bucket: it wakes every 30 min
(15% of bots, sessions of up to 40 actions), 1 h (25%, 40), 2 h (30%, 80), 4 h (20%, 150) or 12 h (10%, 300), with
±25% jitter. Within a session its actions are 3 to 8 s apart; a pause the policy asks for (a respawn, a party mate)
stays in the session when it is at most 90 s, anything longer ends it. Slower agents run longer sessions, so AP
(240 max, 1 per 2 min) is what caps a session; twice-a-day agents still lose the AP regenerated past the cap. The
world clock only moves forward: wake-ups are processed in time order and `tick` runs before each one.

**Profiles** (`src/profiles/`): pure decision functions over what an agent can read (observation, `/me` data, its
own inbox, the answer to its last action, the public `/village` read model) plus a private memory. They coordinate
only through the game: board posts (`lfg`, `campaign`), `say` and party chat, invites, trades.

- **fighter**: hunts monsters of its level alone, follows the tutorial and the dailies it can do alone.
- **explorer**: visits every room safe for its level, gathers, sells the haul; fights now and then.
- **social**: talks, befriends, groups up (`lfg` on the board, "LFG" said at the camp of its level band; whoever
  hears it may invite), hunts at the party camp (announced in party chat, otherwise computed from the leader's
  level), Warrior taunts, Cleric heals on request and revives, hurt members recover at camp, the leader hands on
  gear; chats for Camaraderie. From level 15 a party of 3 or more with 2 classes camps in the Catacombs: it gathers
  at the stairs (party gate), two members online together pull the levers, the Rogue disarms the trap and the Mage
  reads the seal for the deeper camps (`profiles/dungeon.ts`). Everyone from level 10 joins the daily world boss.
- **trader**: picks a profession at level 5, gathers or buys inputs (shops, other agents' market orders), crafts,
  lists goods on the market, offers guaranteed trades, founds or joins a guild.
- **politician**: brings materials and gold to village projects, runs for mayor, campaigns on the board, votes, and
  as mayor sets the priority project, a 3% tax and funds the priority from the treasury.
- **traitor**: plays `social` (that is how it earns trust) and takes its chances first (`OPPORTUNISTIC` in
  `profiles/traitor.ts`): betray a party mate in a lawless room, steal (Rogues, lawless rooms and the village at
  night), ambush a weaker stranger, empty the guild treasury as an officer and leave, vote guild coups, and offer
  pay-first deals ("DEAL: selling ... Pay first with give") it never delivers. All within the server's rules.

Everyone except fighters and explorers votes (candidates come from the board's campaign posts) and answers fair
trades and guild invites. Honest agents react to cheats (`profiles/trust.ts`): a buyer whose paid-for item never came
reports the scam with the `give` event id and stops trusting the seller; agents attacked (or whose party mate was
killed) put a bounty on the attacker; fighters, socials and politicians of level 8+ hunt Wanted agents in lawless
rooms now and then; nobody invites, follows or trades with an agent it learned to distrust or that is Wanted. Honest
traders also sell with pay-first deals and deliver.

**Reading the report.** The JSON holds everything; stdout prints a summary:

- *Time for half of each population to reach a level*: simulated hours (= real hours: a game day is 2 h) until 50% of
  the bots of a group reached it, and the share that did. `solo` is the fighters, `grouped` the socials and
  traitors. *Group/solo speed* compares the two at the highest level half of both reached (the M4 target is 1.8x).
- *Profiles*: level spread, XP per AP spent, deaths, refusal rate, AP by use and XP by source.
- *Cadence buckets*: levels and hours to levels 5/10/15/20 per wake-up rhythm (principle 6: slow agents must not
  fall far behind), and the AP each spends per day.
- *XP by source* (combat, shared kills, quests, gather, craft) and *XP per AP*.
- *Gold*: average/median purse and money supply per agent per day, sources and sinks by action, supply growth
  (inflation) over the last days.
- Deaths, quests by kind, parties (formed, lifetime, size, share of grouped blows struck in a party and with a mate
  in the room), trades and market prices of key goods, projects completed (day), elections (turnout), civic actions.
- *Trust and betrayal*: counts, per day and per 1,000 actions of betrayals, PvP blows and kills, thefts (and failed
  ones), scams reported, bounties placed and claimed, coups, looted treasuries; and the number of PvP or theft events
  that involved an agent below level 8 (the server forbids it: must be 0).
- *Village Gazette*: the server's own chronicle code (`apps/server/src/chronicle/`: highlight detector, day tally,
  gazette builder) fed with the public events, one edition per UTC day, headlines (and with `--gazette` every
  section) rendered in English.
- Kills of group and high-level monsters (dungeon, world boss, elites).
- *Refusals* by code and the most frequent `action:code:message` (a high count means a bot or a hint is wrong), and
  the world near the village: monster slots alive, resources left, pauses by profile and room (starvation shows up
  here).
- `samples`: the hourly time series (gold, levels by group, monsters alive, resources left, parties).

The CI versions are `src/sim.test.ts`: 64 bots for 3.5 simulated days (no invariant broken, under 3% of actions
refused, groups at least 1.8x faster than solo, every profile progresses, traitors betray, scam and get bounties, no
PvP or theft below level 8), and `src/sim.civilization.test.ts`: 30 slower bots for 7.05 days (one full election, 7
gazette editions, the village makes progress; the full `--scenario civilization` run is the one that completes
projects). Both are deterministic for a seed.

## Other files

- `solo.ts`: the solo policy (used by the engine's level 1 to 5 acceptance test and by every profile when fallen,
  fighting or hurt). It decides from a `BotView` (`view.ts`), built from the engine (`viewFromWorld`) or from API
  answers (`viewFromApi` with `/look` or `/act` plus `/me`).
- `live.ts` and `live-runner.ts`: the `pnpm bots` command and the HTTP runner. `personality.ts` holds the live
  personalities and their chat lines per language, `names.ts` the name generator, `pacing.ts` the interruptible waits (Ctrl+C).
- `profiles/`: the simulation's decision functions (`fighter`, `explorer`, `social`, `trader`, `politician`, `traitor`,
  and the shared `common.ts`, `trust.ts` and `dungeon.ts`).
- `sim/`: the simulation itself: `runner.ts` (the world, the clock and the scheduler), `metrics.ts` (the report) and
  `format.ts` (what is printed).
- `sim-cli.ts`: the `pnpm sim` command.

Licence: AGPL-3.0, like the rest of the core (the bots are not part of the MIT packages).
