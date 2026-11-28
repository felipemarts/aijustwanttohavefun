# AI Just Want to Have Fun: player app (Android, iOS, and the desktop interface)

One Expo app (SDK 58, React Native 0.88, Expo Router) with three cores behind the same interface:

| Where | Core | What plays |
|---|---|---|
| Android, iOS | `LocalCore` from `../core-ts` (`@ajwf/client-core`), in the app | the built-in model on the phone (llama.rn), or an Ollama / LM Studio / OpenAI-compatible server on your network |
| Web export served by the desktop program | `RemoteCore`: HTTP and SSE to `../desktop` | whatever the desktop program uses |
| Anywhere, for development | `MockCore` (`?mock=1` on the web, `EXPO_PUBLIC_CORE=mock` in a build) | fake characters on timers |

`src/core/choose.ts` picks the core; `src/core/create-local.native.ts` builds `LocalCore` with its ports. The contract
is `../playkit/core-api.ts`. Licence: MIT (`LICENSE`).

**Nothing in this folder has been run on a phone, an emulator or a simulator, and no native build has been made.**
What was checked: TypeScript, lint and unit tests (including every native port adapter against fakes), and Metro
bundles for Android, iOS and the web (`npx expo export --platform android|ios|web`).

## Prerequisites

- Node 22.13 or later, npm. The repository root is a pnpm workspace that does not include `clients/`; this app uses
  npm on its own.
- The sibling folders `../core-ts` and `../playkit` (a `file:` dependency and a type-only import).
- Android: Android Studio with an SDK, JDK 17, and an **arm64** device (the build is limited to `arm64-v8a`).
- iOS: a Mac with Xcode and CocoaPods, a real device, and an Apple developer account whose team can use the
  **Increased Memory Limit** capability (`com.apple.developer.kernel.increased-memory-limit`, needed to load a 1.1 GB
  model). A free personal team cannot; to try anyway, remove that entitlement from `app.json`, knowing the model may
  then fail to load.

```sh
cd clients/mobile
npm ci        # llama.rn's postinstall downloads its prebuilt native libraries (about 800 MB)
npm run check # typecheck, lint, unit tests
```

## Development build

The app uses native modules (llama.rn, expo-sqlite, expo-secure-store, expo-file-system), so it needs a development
build; Expo Go cannot run it. `android/` and `ios/` are generated from `app.json` and are not committed.

Local:

```sh
npx expo run:android --device   # generates android/, builds, installs on the connected phone
npx expo run:ios --device       # generates ios/ and installs; choose your signing team in Xcode the first time
npx expo start --dev-client     # afterwards: the JavaScript server the development build connects to
```

EAS (cloud): `eas.json` has `development`, `preview` and `production` profiles.

```sh
npx eas-cli@latest build --profile development --platform android
npx eas-cli@latest build --profile development --platform ios
```

EAS uploads the git repository and builds in this folder, so `../core-ts` and `../playkit` must be committed (or set
`EAS_NO_VCS=1`). llama.rn's config plugin adds its own iOS entitlements only for production profiles; `app.json` sets
Increased Memory Limit explicitly so development builds have it too.

## The game server

The app plays on the game server in **Settings → Game server address**. A build can set the first-run default with
`EXPO_PUBLIC_GAME_SERVER=https://…` (for example in an `eas.json` profile's `env`). Without it the default is
`http://localhost:8710`, which on a phone is the phone itself: for a development server on your computer, use the
computer's address on the local network (`http://192.168.x.y:8710`) and make sure the server listens on that interface.

## Testing on a device

**Built-in model.** AI engine → Download (about 1.1 GB; Wi-Fi, and about 1.3 GB free). After the download the app
checks the file against its pinned SHA-256 ("Checking the download"), once; the result is remembered against the file's
size and modification time. Pause keeps the partial file; Cancel deletes it. Expect it to need a recent phone with
plenty of memory; how much was not measured.

**Ollama or LM Studio on your computer.** The phone reaches them over the local network:

- Ollama: start it listening on the network (`OLLAMA_HOST=0.0.0.0 ollama serve`), pull a model.
- LM Studio: in the server settings, turn on serving on the local network; load a model.
- In the app: AI engine → the Ollama or LM Studio card (or Custom address) → type `http://<computer's LAN address>:11434`
  (Ollama) or `:1234` (LM Studio) → Check → pick a model → Use this → Test.
- iOS asks for Local Network permission the first time. Android allows plain HTTP for this
  (`usesCleartextTraffic`): its network security config can only list host names, not "any LAN address", so cleartext
  is allowed app-wide; the game server itself should be HTTPS.

**Without a model**, `test-support/engine-stub.mjs` is a scripted OpenAI-compatible server (valid decisions picked
from the request's JSON Schema, about one per second; `POST /stub/mode {"mode":"stall"|"error"}` to see failures):
`node test-support/engine-stub.mjs --port 8797`, then point the Custom address at `http://127.0.0.1:8797`. For a phone,
add `--host 0.0.0.0` (only on a trusted network) and use `http://<computer's LAN address>:8797`.

## Desktop interface

`../build-webui.sh` exports this app for the web and copies it into the desktop program
(`../desktop/internal/webui/dist/`); see `../desktop/README.md`.

## Known not to work, or not verified

- Not run on any device, emulator or simulator; no native build made. The native config (`npx expo config --type
  introspect`) shows the permissions, entitlements and plugins, but no build has compiled them.
- Play stops when the app is in the background (the OS suspends JavaScript). Keep-awake only keeps the screen on while
  the app is open and a character is set to play.
- The model download uses expo-file-system's native download task; resuming after the app was killed relies on its
  saved pause state and was not tried. Its progress numbers after a resume are interpreted defensively (see
  `src/core/native/files.ts`).
- llama.rn speed, memory use and the JSON-Schema-constrained output on a phone were not measured.
- Character sprites may look soft on Android and iOS: React Native's `Image` smooths when it scales (the web build
  draws them pixel-exact).
- Hashing 1.1 GB in JavaScript (`@noble/hashes`, 4 MB chunks) was only tested on small files; on a phone it may take a
  minute or more.
