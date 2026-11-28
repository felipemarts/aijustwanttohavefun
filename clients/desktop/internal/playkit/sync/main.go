// Command sync copies clients/playkit/{playkit.json,prompts/*.txt} into internal/playkit/kit so they can be
// embedded. Run by `go generate ./internal/playkit` from clients/desktop.
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	src := filepath.Join("..", "..", "..", "playkit")
	dst := "kit"
	files := []string{"playkit.json"}
	prompts, err := filepath.Glob(filepath.Join(src, "prompts", "*.txt"))
	if err != nil {
		fail(err)
	}
	for _, p := range prompts {
		rel, _ := filepath.Rel(src, p)
		files = append(files, rel)
	}
	files = append(files, filepath.Join("bench", "situations.json"), filepath.Join("vectors", "schema.json"), filepath.Join("vectors", "map.json"))
	if err := os.RemoveAll(filepath.Join(dst, "prompts")); err != nil {
		fail(err)
	}
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(src, f))
		if err != nil {
			fail(err)
		}
		out := filepath.Join(dst, f)
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			fail(err)
		}
		if err := os.WriteFile(out, b, 0o644); err != nil {
			fail(err)
		}
	}
	fmt.Printf("synced %d playkit files\n", len(files))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "sync:", err)
	os.Exit(1)
}
