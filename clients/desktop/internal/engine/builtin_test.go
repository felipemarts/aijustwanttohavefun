package engine

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSafeJoin(t *testing.T) {
	dir := t.TempDir()
	for _, bad := range []string{"../x", "a/../../x", "/etc/passwd", "..\\x"} {
		if _, err := safeJoin(dir, bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if p, err := safeJoin(dir, "llama-b1/llama-server"); err != nil || !strings.HasPrefix(p, dir) {
		t.Errorf("good path: %v %v", p, err)
	}
}

func TestExtractRefusesEscapes(t *testing.T) {
	dir := t.TempDir()
	// A tar with a symlink pointing outside.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "x/link", Typeflag: tar.TypeSymlink, Linkname: "../../outside"})
	tw.Close()
	gz.Close()
	arch := filepath.Join(dir, "a.tar.gz")
	_ = os.WriteFile(arch, buf.Bytes(), 0o600)
	if err := extract(arch, filepath.Join(dir, "out")); err == nil {
		t.Fatal("escaping symlink accepted")
	}
	// A zip with ../ in a name.
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	f, _ := zw.Create("../evil.txt")
	_, _ = f.Write([]byte("x"))
	zw.Close()
	zarch := filepath.Join(dir, "a.zip")
	_ = os.WriteFile(zarch, zb.Bytes(), 0o600)
	if err := extract(zarch, filepath.Join(dir, "out2")); err == nil {
		t.Fatal("zip slip accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "evil.txt")); err == nil {
		t.Fatal("file written outside")
	}
}

func TestFetchVerifiesHashAndResumes(t *testing.T) {
	payload := bytes.Repeat([]byte("model"), 1000)
	sum := sha256.Sum256(payload)
	good := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "m", serverTime, bytes.NewReader(payload))
	}))
	defer srv.Close()
	b := &Builtin{CacheDir: t.TempDir()}
	dst := filepath.Join(b.CacheDir, "m.gguf")
	// A partial file is resumed with a Range request.
	_ = os.WriteFile(dst+".part", payload[:1234], 0o600)
	if err := b.fetch(context.Background(), srv.URL, dst, int64(len(payload)), good, 0); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, payload) {
		t.Fatal("content differs")
	}
	// A wrong pinned hash: refused and the download deleted.
	dst2 := filepath.Join(b.CacheDir, "m2.gguf")
	err := b.fetch(context.Background(), srv.URL, dst2, int64(len(payload)), strings.Repeat("0", 64), 0)
	if err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("mismatch: %v", err)
	}
	for _, p := range []string{dst2, dst2 + ".part"} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("%s kept after a mismatch", p)
		}
	}
	// Larger than pinned: refused.
	if err := b.fetch(context.Background(), srv.URL, filepath.Join(b.CacheDir, "m3"), 10, good, 0); err == nil {
		t.Fatal("oversize accepted")
	}
}

func TestPinsCoverEveryTarget(t *testing.T) {
	for _, p := range []string{"windows/amd64", "windows/arm64", "darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64"} {
		a, ok := LlamaAssets[p]
		if !ok || len(a.SHA256) != 64 || a.Size <= 0 || !strings.Contains(a.File, LlamaBuild) {
			t.Errorf("%s: %+v", p, a)
		}
	}
	if len(ModelSHA256) != 64 || len(ModelRevision) != 40 || ModelSize <= 0 {
		t.Error("model pin incomplete")
	}
}

func TestNormalizeURL(t *testing.T) {
	for in, want := range map[string]string{"http://127.0.0.1:1234/v1/": "http://127.0.0.1:1234", "https://x.example/api/v1": "https://x.example/api"} {
		if got, err := NormalizeURL(in); err != nil || got != want {
			t.Errorf("%s: %s %v", in, got, err)
		}
	}
	for _, bad := range []string{"file:///etc", "javascript:x", "http://user:pw@h", "localhost:11434"} {
		if _, err := NormalizeURL(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

var serverTime = mustTime()
