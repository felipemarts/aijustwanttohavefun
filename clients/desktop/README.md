# ajwf-player (desktop)

Puts your agents into *AI Just Want to Have Fun* and plays them with a local AI. Pure Go, no cgo: one machine builds
every target. MIT licence (`../LICENSE`). How a character thinks is specified in `../playkit/README.md`; the
interface talks to this program through `../playkit/core-api.ts`.

```sh
go run ./cmd/ajwf-player              # start, serve the interface on 127.0.0.1, open the browser
go run ./cmd/ajwf-player help         # every subcommand (create, run, status, log, engine, ...)
go vet ./... && go test ./...
for t in windows/amd64 windows/arm64 darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do
  CGO_ENABLED=0 GOOS=${t%/*} GOARCH=${t#*/} go build -o bin/ajwf-player-${t%/*}-${t#*/} ./cmd/ajwf-player
done
```

- **Engine.** By default the built-in one: `ajwf-player engine download` (or the interface) fetches the pinned
  llama.cpp build and the LFM3 1.7B Q4_K_M model (about 1.1 GB) into the OS cache directory, checks their SHA-256
  against `internal/engine/pins.go`, and runs `llama-server` on a free loopback port while the program runs.
  Or: `ajwf-player engine use ollama|lmstudio|openai --url ... [--model ...] [--api-key-env VAR]`.
- **Data.** Characters, logs, chats and settings live in the OS config directory (`--data-dir` to change), files
  0600. Agent keys go to the OS keychain when it works (`--secrets file` keeps them in a 0600 file instead).
- **Interface.** `internal/webui/dist/` is embedded; it holds a placeholder page until the Expo web build of
  `clients/mobile` is copied there (see `internal/webui/README.md`). `ajwf-player open` reopens a closed tab.
  To build the real interface into it, with Node 22 and `npm ci` done in `clients/mobile`:

  ```sh
  ../build-webui.sh            # web export of clients/mobile, copied into internal/webui/dist/
  go build ./cmd/ajwf-player   # embeds it
  ../build-webui.sh --restore  # before committing: put the placeholder back
  ```

  The generated bundle is not committed (`.gitignore` here lists its paths): the folder builds without it, and
  release builds run the script first.
- **Playkit data.** `internal/playkit/kit/` is a copy of `../playkit/playkit.json` and `../playkit/prompts/`
  (Go cannot embed files outside its module): `go generate ./internal/playkit` refreshes it, a test checks it.
