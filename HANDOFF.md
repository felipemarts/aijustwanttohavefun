# Handoff

You are taking over this repository from another agent. This file says what the project is, what is built and how it
was checked, where the work in progress stopped, and what to do next. `TODO.md` lists the known gaps of the game one
line each, `docs/DEPLOY.md` covers production, `docs/ISSUES.md` has starter issues.

Everything is on `main` at `github.com/felipemarts/aijustwanttohavefun`, a public repository. **A push to `main` that
passes CI is deployed automatically** to the owner's server for `https://aijustwanttohavefun.com` (`docs/DEPLOY.md`
section 14). So push only when the owner asks, and never push a server change you have not run the full check on.

The original specification, `PLANEJAMENTO.md` (Portuguese), was deleted from the tree at the owner's request. Many
code comments cite it as "PLANEJAMENTO §N". Read it with `git show 3f51c5e:PLANEJAMENTO.md` when you need the
reasoning behind a game rule; the previous version of this file is at `git show 3f51c5e:HANDOFF.md`.

## The product

"AI Just Want to Have Fun" is an idle, persistent text MMORPG whose players are AI agents. Any LLM plays through a
small HTTP API (or MCP); humans do not play, they own agents and watch the world on a 2D pixel-art map in the browser.
The quality bar for every feature is "is this fun to watch?".

Rules of the design that must not change without asking the owner:

- The server never calls an LLM. NPCs, narration and the gazette come from templates; inference is paid by owners.
- Text written by an agent is untrusted, for the server and for other agents.
- Nothing assumes a language. Six ship: en (reference), pt-BR, es, fr, ja, zh-CN.
- No monetisation. Server, engine, web and content are AGPL-3.0; `packages/shared`, `packages/mcp`, `packages/sdk`,
  `tools/example-agent` and everything under `clients/` are MIT.
- TypeScript, pnpm workspaces, Fastify + `ws`, one process, state in memory with snapshots in Postgres, Vite + React +
  PixiJS, Zod, Vitest.

## State at a glance

| Part | State |
|---|---|
| Game (milestones M0 to M8 of the spec) | Implemented, tested and deployed on a single VM behind nginx, with continuous deployment from CI. The launch checklist of `docs/DEPLOY.md` section 13 was not walked through on the production host. |
| Added later: wishing fountain, rebuilt director mode, director voice | Done and committed |
| Player clients (`clients/`) | **In progress, interrupted.** See the next section; this is where you continue. |

Checks on the last commit, run on a quiet machine: `pnpm typecheck` and `eslint` clean, 940 tests passing and 3
skipped (the Postgres store tests, which need `TEST_DATABASE_URL`), `content:check` clean, web build clean, six
languages at 100%. On a loaded machine `tools/bots/src/sim.test.ts` exceeds its 120 s setup timeout; that is load, not
a regression.

## Player clients: the work in progress

The owner asked for a desktop client in Go (Windows, macOS, Linux) and a phone client in Expo (Android, iOS) that let
a person put characters to play with a **local** model, watch their progress and talk to them, as an idle MMO. Liquid
LFM3 is the default model; Ollama, LM Studio and any OpenAI-compatible URL must also work.

### Layout

| Folder | What it is |
|---|---|
| `clients/playkit/` | How a character thinks, as data: `playkit.json` (version 2.0.0), prompt templates, golden vectors, a situation bench, and `README.md` with the full turn algorithm. Also `core-api.ts`, the contract between any core and the interface. Both cores must behave identically; the vectors enforce it. |
| `clients/desktop/` | The Go program (`ajwf-player`), pure Go, no cgo. Runs the characters, manages the engine, serves the interface on 127.0.0.1 and opens the browser. It is the reference implementation of the playkit (`internal/playkit`). |
| `clients/core-ts/` | The same core in platform-neutral TypeScript, for the phone app, with ports for storage, secrets, model files and the model runtime. |
| `clients/mobile/` | The interface, an Expo app (SDK 58). On desktop its web export is embedded in the Go program; on phones it runs `core-ts` in-app. Six languages. |
| `clients/build-webui.sh` | Exports the web interface into `clients/desktop/internal/webui/dist/`; `--restore` puts the tracked placeholder back. The exported bundle is not committed. |

`clients/` is outside the pnpm workspace and outside the root ESLint. Each folder has its own checks:

| Folder | Check | Result when I last ran it |
|---|---|---|
| `clients/desktop` | `go vet ./... && go test ./...`, then build for windows, darwin, linux on amd64 and arm64 with `CGO_ENABLED=0` | vet clean, 24 tests pass. Six targets built at the v1 state and, by the Go agent's note, again late in v2; I did not rebuild them after its last edits. |
| `clients/core-ts` | `npm run check` | typecheck and lint clean, 59 tests pass, 109 skipped (see below) |
| `clients/mobile` | `npm run check` | passes |

### How the pieces were verified

- **Go program, version 1 of the brain:** a character played 150 real turns on the built-in LFM3 1.7B (Q4_K_M) on an
  8 GB M1: 13 tokens/s, about 10 s per turn, every answer schema-valid, 71% of actions accepted by the game, 4
  tutorial quests, then stuck at level 1, one avoidable death. Verdict: it follows explicit steps but cannot explore,
  fight sensibly or hold a conversation.
- **Interface against the real Go program**, in Chromium at phone and desktop widths, English and Portuguese: session
  cookie flow, engine screen (installed model; download, pause, resume, cancel against a scratch cache), the
  OpenAI-compatible provider flow, about 40 turns arriving over SSE, a command sent in Talk obeyed, the claim link.
  This was against the Go program **before** the nine defects below were fixed.
- **TypeScript core:** all 85 version 1 golden vectors pass (I re-ran them against a v1 snapshot), plus 40 turns
  against a real game server with a scripted stand-in for the model.
- **Not verified anywhere:** anything on a phone, an emulator or a native build; Windows and Linux at run time (they
  only cross-compile); Ollama and LM Studio against the real programs (not installed on this machine); the OS keychain
  outside macOS.

### Where each piece stopped

Two agents were cut off mid-task by a spend limit, without a final report. What follows is from their notes and from
what I could re-run.

**Go program and playkit version 2.** The owner's ruling after the version 1 result: code decides survival, routes and
what is on the menu; the model picks from a short curated menu and supplies personality and speech. Written and in
the tree:

- The planner (`internal/playkit/planner.go`, README section 10): modes, a menu of about 6 actions, survival filters,
  frontier exploration, speech rules (only with someone present, no near-repeats), remembered deaths.
- A crude, foul-mouthed default voice in `prompts/system.txt`, which the owner's persona overrides; thoughts and notes
  in the character's language. The owner asked for the crude voice because it is funnier to watch.
- A situation bench: `clients/playkit/bench/situations.json`, 32 recorded situations with machine-checked
  expectations, run with `ajwf-player bench` (README section 11). Its last pass: 32 of 32, 5 minutes of model time.
- Keep-awake while a character plays (`internal/awake`, `Settings.keepAwake`), `CharacterSummary.stuck`, a timeout on
  engine requests, and fixes for nine defects the interface test found (cancelled download shown as paused, raw engine
  errors on screen, characters created paused, summaries not re-rendered on a language change, raw JSON on a
  cross-site navigation, clipped thoughts). The agent wrote tests for these; the interface has not been re-checked
  against them in a browser.

The acceptance run was interrupted. Targets for a fresh claimed character in 300 turns: whole tutorial chain, level
3, at most one death, at least 85% accepted, no utterance repeated verbatim, one real two-sided exchange. The partial
result, two characters at about 100 turns each (a cleric in Portuguese, a warrior in English):

| Measure | Result at about turn 100 |
|---|---|
| Accepted by the game | 100% for both |
| First answer valid | 99% and 100% |
| Tutorial quests done | 6 each, by turn 60 |
| Level | still 1 |
| Deaths | 0 |
| Speech | all lines distinct, 2 and 4 replies to someone, nothing masked by the game's word filter |

Two problems were visible when it stopped:

- After the sixth quest the characters mostly walk (about 60% of actions are `move`). The agent's last note blames
  `placeIn` in the planner, which skips the current room, so a quest place never matches while standing in it. It was
  removing that exclusion when it was cut off; check whether the edit landed.
- The English character opened 9 of its 14 lines with "Oi, you lazy sod", one of the voice examples in
  `playkit.json`. The near-repeat rule compares whole lines and misses a repeated opener.

**TypeScript core.** It implements playkit version 1. The playkit on disk is now 2.0.0, so the vector test skips the
version-dependent cases (that is the 109 skipped) rather than fail. It needs the sync to version 2. The author left
the menu as two lists of steps (`ACTION_STEPS`, `MENU_STEPS`) for that purpose, and `npm run sync-playkit` embeds the
kit. The "What changed" list at the end of `clients/playkit/README.md` is meant to drive the sync; it may miss the
agent's last hour of changes, so diff against the Go code as well.

**Interface, second pass.** In the tree: the contract's `stuck` field with wording in the interface, the keep-awake
toggle, the persona hints about the crude voice, the in-app core wired for phones (`src/core/create-local.native.ts`
and `src/core/native/` adapters for secure storage, SQLite, file system, `llama.rn`), a streamed SHA-256 check of the
model file, `eas.json`, and `clients/mobile/README.md` for building on another machine. By the agent's note the
Android and iOS JavaScript bundles build (`npx expo export --platform android|ios`). Not done: the web export and the
browser check of the screens changed in this pass, and its final report, so treat these as open questions: whether
`expo/fetch` honours `redirect: 'manual'`, whether the Android cleartext and architecture settings appear in
`npx expo config --type introspect`, and whether it needed changes to `clients/core-ts/src/ports.ts`.

### What to do next, in order

1. **Finish playkit version 2 in Go.** Check the `placeIn` edit, fix the repeated opener, run `go vet` and `go test`,
   then the bench, then one acceptance run. Report the table above at turns 100, 200 and 300. If the targets are
   missed, say which and why; the owner will decide whether LFM3 stays the default.
2. **Sync `clients/core-ts` to version 2** until every vector passes with none skipped.
3. **Finish the interface pass:** web export, browser check of the changed screens against the current Go program,
   then `clients/build-webui.sh` and a run of the Go program with the real interface embedded.
4. **Translate the interface's pending keys:** 33 keys listed in `PENDING_KEYS` in `clients/mobile/src/i18n/i18n.ts`
   need es, fr, ja and zh-CN; translator notes are in `src/i18n/notes.en.json`. Then empty the list.
5. **One short real-model run of the TypeScript core** (about 10 turns through `harness/play.ts` against a local
   `llama-server`), which has never been done.
6. **CI and docs:** jobs for the three client folders, a section in the root `README.md` (it does not mention the
   clients yet), and player-facing instructions.
7. **Native builds** on a machine with room for them, following `clients/mobile/README.md`. This machine cannot.

### Rules for testing with the local model

The owner set these after three agents loaded the model at once and the machine reached a load of 68 with under 1 GB
free. They are not optional.

- One `llama-server` at a time, and one agent owns it. Check with `pgrep -fl llama-server` before starting one.
- Anything that tests plumbing uses a scripted engine: `clients/mobile/test-support/engine-stub.mjs` and
  `clients/core-ts/test/fixtures/model-stub.ts` answer the OpenAI-compatible API with valid decisions and can stall or
  fail on request.
- Test model quality with the bench (5 minutes) before any live run (50 minutes or more).
- At most two full acceptance runs for playkit version 2. None has completed. After the second, stop and report.
- The model (1.1 GB) and the pinned `llama-server` are cached in `~/Library/Caches/ajwf-player`. Do not delete them.
  Pins and hashes are in `clients/desktop/internal/engine/pins.go`.

### Security rules of the clients

- The Go core binds 127.0.0.1 only, checks Host, Origin and Sec-Fetch-Site on every request and sends no CORS headers.
  Keep the guard strict on `/core/*`.
- An agent's API key lives in the OS keychain (or a 0600 file), never in state, events, logs or prompts, is sent only
  to its own game server and never follows a redirect. A model answer containing `ajwf_sk_` is refused.
- Other players' text enters a prompt only quoted inside `<chat>`, one escaped line per message.
- Actions are constrained twice: by the per-turn JSON schema and by validation before anything is sent. With
  `allowPvp: false` the harmful actions are removed from both.
- Downloads are pinned by revision and SHA-256; a mismatch deletes the file.

## Decisions waiting for the owner

1. **Profanity filter.** The game masks the strongest swear words with asterisks in every `say` and `whisper`
   (`packages/shared/src/moderation.ts`), slurs and plain profanity in one list. The owner asked for crude-talking
   characters. My recommendation, not yet approved: split the list, keep slurs always masked, let plain profanity
   through in speech and keep it out of names. Do not change the filter without the owner's answer.
2. **LFM3 as the default** if the acceptance run misses its targets.
3. Party invites accepted from any room, and a party "follow" action (my recommendation: yes to both).
4. How often the director cuts early to another character (every 7 to 13 s in the mock world).
5. The departures from the spec listed below, the party XP rule first.
6. Production (`docs/DEPLOY.md` sections 3 and 14, `CLIENT_IP_HEADER=X-Real-IP`) still lacks: the GitHub and Google
   OAuth apps (section 7), without which no owner can log in or claim an agent; copies of the backups off the machine;
   the metrics scrape and alerts (section 11).
7. A real contact address in `CODE_OF_CONDUCT.md`, and the repository URL used across the docs, which say
   `github.com/aijustwanttohavefun/aijustwanttohavefun` while the repository lives under the owner's account.
8. Review of Japanese and Simplified Chinese by native speakers; both were machine-translated.
9. Desktop client: it opens in the browser, with no native window or tray icon. Confirm that is acceptable.
10. With the crude voice on by default, a store listing of the phone app will probably need an adult age rating.

## Environment (read before running anything)

- macOS, 8 GB of RAM, disk space is tight. Node 22 through nvm; the default shell Node is v20, so prefix commands with
  `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" &&`. Go 1.26.
- **Ports:** game server **8710**, web **5710**. Ports 8080 and 5173/5174 belong to Docker containers of another
  project of the owner: do not use them and do not stop those containers. A demo for the owner may be running on 8720
  (server) and 5710 (Vite); leave it unless asked.
- Stop servers by PID only (`lsof -ti :8710`, then `kill <pid>`). Never kill every `node` process: another project
  runs on this machine. zsh does not split an unquoted variable holding several PIDs; loop over them.
- Without `DATABASE_URL` the server uses an in-memory store, so `pnpm dev` works on a clean machine. With Postgres:
  `docker compose up -d postgres`, credentials in `.env.example`.
- The dev server listens on loopback only (`HOST`, default 127.0.0.1 outside production).
- The terminal rewrites command output through a filter that hides Vitest summaries and shortens long lines. Run
  `npx vitest run --reporter=json --outputFile=.vitest/all.json`, read the totals from the JSON, and trust exit codes.
- Registration is limited to 5 per hour per IP; test players register with the header `X-Admin-Token` and
  `"claimed": true`, as `tools/bots` does.
- Playwright screenshots go under the repo (`.playwright-mcp/`, gitignored).

## Commands

| What | Command |
|---|---|
| Everything a commit to the game must pass | `pnpm typecheck && pnpm lint && pnpm test && pnpm content:check && pnpm i18n:report && pnpm --filter @ajwf/web build` |
| Server and web together | `pnpm dev`, then http://localhost:5710 |
| Web with a simulated world, no server | http://localhost:5710/?mock=1 (also `?stress=500`, `?built=all`, `?debug=1`) |
| Scripted bots against a running server | `pnpm bots --url http://localhost:8710 --count 30 --duration 300 --admin-token dev-admin` (the server needs the same `ADMIN_TOKEN`) |
| In-process simulation | `pnpm sim` (see `tools/bots/README.md`) |
| Benchmarks | `pnpm bench` |
| Desktop client | in `clients/desktop`: `go run ./cmd/ajwf-player` (`--no-open`, `--port`, `--data-dir`); `ajwf-player bench` |
| Interface with fake data | in `clients/mobile`: `npm run web` (port 8791), then open it with `?mock=1` (`&engine=off`, `&stuck=1`) |

## Architecture of the game in one page

- **No build step.** Packages export `./src/*.ts`; the server runs with `tsx`; Vite and Vitest read TypeScript.
- **`packages/engine` is pure.** `applyAction(state, {agentId, action, params}, {now, rng, luck?})` returns
  `{result, events}` and never throws. Handlers validate first with `fail(CODE, 'slug', params)` and only then mutate;
  a refusal leaves the world byte-identical, which the fuzzers assert. All tuning is in `balance.ts`.
- **Text is keys, not strings.** The engine emits `{k, p}` messages; the server renders them in the agent's language.
  Content text lives in `packages/content/i18n/<lang>/`, interface and narration in `packages/i18n/locales/<lang>/`.
- **`apps/server`** wraps the engine: Fastify, snapshots every 5 s, hashed API keys and claim tokens, rate limits,
  idempotency keys, token budgets on `/look` and `/act`, the spectator WebSocket, the chronicle, owner accounts
  (OAuth with PKCE), Web Push, share cards, admin routes, MCP at `/mcp`, and `GET /api/v1/schema` (the JSON Schema of
  every action's params, which the clients use to constrain a model's output).
- **`apps/web`** keeps its store outside React; the map is PixiJS with procedural CC0 pixel art drawn in code.
- **Director mode** follows one agent, the star. While it is on, the screen plays 30 s late so an undelayed scout can
  cut to an agent just before their moment. Interest is scored per agent on the server
  (`packages/shared/src/interest.ts`). An optional voice reads the star's lines and a narrator through the browser's
  speech synthesis, in English and Portuguese only; how it sounds was never checked by ear.
- **Wishing fountain:** action `wish` in the village square. Once the pot holds 25 gold each coin has a hidden 0.2%
  chance of returning the whole pot; nothing told to agents states it. The roll uses `ActionCtx.luck`, an
  unpredictable source the server passes, not the shared seeded generator.

## Security rule for game code

An independent audit's one critical finding: `market_buy` with the order id `__proto__` turned an agent's gold into
`NaN`. **Never index a record with a key that came from a parameter, a bundle or a snapshot using `[]` or `in`; use
`own` and `hasOwnKey` from `packages/shared/src/own.ts`. Move gold and items only through
`packages/engine/src/ledger.ts`.** `fuzz.hostile.test.ts` feeds hostile keys and numbers into every action.
Agent-written text is only ever delivered under `untrusted_text`, after `sanitizeAgentText`.

Risks left open on purpose are in `TODO.md` ("Security design notes").

## Where the game departs from the spec

Decided during implementation, waiting for the owner to confirm or reverse:

- **Party XP is not divided.** With the spec's rule the M4 acceptance (groups 1.8x faster) could not be met. Each
  member gets the side's share times `1 + 0.1 × (n − 1)`.
- The tutorial does not require voting, since an election may not be open.
- Dungeon timings are wide (lever window 10 min, ways open 2 h, gate held up to 30 min) so agents playing in sessions
  can coordinate.
- Project costs were raised 12x, 20x and 30x by tier, and tavern `rest` costs more above level 10, as gold sinks.
- Kills in self-defence give no Infamy.
- Election totals are sealed until the close; the audit showed live totals exposed each vote.
- Guild names are limited to 3 words, and names resembling instructions are refused.

## What playtests say about the game

Three rounds of five Haiku-class LLM players in Portuguese, about 100 actions each with 20 scripted bots, rated the
game 6 to 7 out of 10. They liked the other agents; logistics hurt. Still unfixed, mostly balance:

- Monsters and gatherables near the village are fought over, so kills and herbs vanish between two calls.
- Parties scatter, and accepting an invite needs the same room.
- Trade offers go unanswered, so the daily trade quest stalls.
- Nobody passed level 2 in 120 actions. The local-model runs above show the same: six tutorial quests, still level 1.
- One unconfirmed report of ten wolf kills with no pelt (the drop chance is 40%).

## Working rules the owner set

- Small commits, each with its tests, ending with the co-author trailer. Commit locally; push only when asked, since a
  push to `main` deploys to production. CI also scans the whole history for secrets with gitleaks: a realistic-looking
  key in a test fixture fails the run and blocks the deploy.
- When delegating to subagents: the lead session does management, architecture, security and design; Opus-class agents
  implement; Sonnet-class agents write translations, dialogue, story and quests. Always name the model explicitly.
- Never more than 10 agents running at once, and watch the spend: the last round ended when two agents hit the
  account's spend limit mid-task.
- Be precise with tests: model time on this machine is the scarce resource.
- The owner writes in Portuguese; reply in Portuguese. Code, comments and docs in the repository are in English.
