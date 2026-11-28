#!/bin/sh
# Builds the interface (the Expo web export of clients/mobile) and puts it where the desktop program embeds it:
# clients/desktop/internal/webui/dist/. Then rebuild the Go program (`go build ./cmd/ajwf-player`) to ship it.
#
#   clients/build-webui.sh            export and copy
#   clients/build-webui.sh --restore  put the tracked placeholder page back (before committing, or to undo)
#
# The exported bundle is not committed: the folder builds without it (go:embed only needs the tracked placeholder),
# and a 1.4 MB generated bundle would change on every interface edit. Release builds run this script first.
# Needs Node 22 and the dependencies of clients/mobile (`npm ci` there).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
mobile="$here/mobile"
dist="$here/desktop/internal/webui/dist"
placeholder="index.html app.js style.css"
backup="$mobile/.webui-placeholder"   # ignored by clients/mobile/.gitignore

if [ "${1:-}" = "--restore" ]; then
  # Remove everything the export added, then restore the tracked placeholder files from git.
  find "$dist" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
  if (cd "$here/.." && git checkout -- "clients/desktop/internal/webui/dist" 2>/dev/null); then
    echo "Placeholder restored from git in $dist"
  elif [ -d "$backup" ]; then
    cp -R "$backup/." "$dist/"
    echo "Placeholder restored from $backup (not tracked by git yet)"
  else
    echo "No placeholder to restore: not in git and no backup" >&2
    exit 1
  fi
  exit 0
fi

[ -f "$mobile/package.json" ] || { echo "clients/mobile not found next to this script" >&2; exit 1; }
[ -d "$mobile/node_modules" ] || { echo "Run 'npm ci' in clients/mobile first" >&2; exit 1; }

echo "Exporting the web build of clients/mobile..."
(cd "$mobile" && CI=1 npx expo export --platform web --output-dir dist >/dev/null)
[ -f "$mobile/dist/index.html" ] || { echo "The export produced no index.html" >&2; exit 1; }

# Keep a copy of the placeholder the first time, so --restore works even before it is committed.
if [ ! -d "$backup" ] && [ -f "$dist/app.js" ]; then
  mkdir -p "$backup"
  for f in $placeholder; do [ -f "$dist/$f" ] && cp "$dist/$f" "$backup/"; done
fi

# Replace the folder's contents. go:embed needs the folder to exist and hold at least one file: the export always has
# index.html, which is also what the Go server falls back to for client-side routes. metadata.json is Expo's own and
# not needed at run time.
find "$dist" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
cp -R "$mobile/dist/." "$dist/"
rm -f "$dist/metadata.json"

echo "Copied to $dist:"
(cd "$dist" && find . -type f | sort | sed 's/^/  /')
echo "Now rebuild the desktop program: (cd clients/desktop && go build ./cmd/ajwf-player)"
echo "Before committing, run '$0 --restore' so the generated bundle is not committed (placeholder files: $placeholder)."
