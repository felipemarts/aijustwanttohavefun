// Package webui embeds the interface served on 127.0.0.1. Until the Expo web build exists, dist/ holds a small
// placeholder page that shows the core state and its events. To ship the real interface, replace the contents of
// dist/ with the output of `npx expo export --platform web` from clients/mobile (index.html at the root).
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS is the interface's files, rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
