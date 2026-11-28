package engine

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Builtin downloads the pinned llama.cpp build and model into the cache directory, verifies them, and runs
// llama-server on a free loopback port for as long as the program runs.
type Builtin struct {
	CacheDir string
	// Log receives one line per notable step (never secrets).
	Log func(string)

	mu         sync.Mutex
	state      string // not_installed, downloading, starting, ready, error
	code       string // why, for the interface (the core words it): paused, cancelled, checking, loading, hash_mismatch, start_failed, not_ready, download_failed, stopped, unsupported
	message    string // the detail, in English, for the log only
	bytesDone  int64
	bytesTotal int64
	cancel     context.CancelFunc
	cmd        *exec.Cmd
	port       int
	key        string
	client     *OpenAI
	exited     chan struct{}
}

// BuiltinStatus is a snapshot for EngineState.
type BuiltinStatus struct {
	State      string
	Code       string
	Message    string
	BytesDone  int64
	BytesTotal int64
}

func (b *Builtin) logf(format string, a ...any) {
	if b.Log != nil {
		b.Log(fmt.Sprintf(format, a...))
	}
}

func (b *Builtin) asset() (LlamaAsset, error) {
	a, ok := LlamaAssets[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return LlamaAsset{}, fmt.Errorf("no built-in engine for %s/%s: use Ollama, LM Studio or another server", runtime.GOOS, runtime.GOARCH)
	}
	return a, nil
}

func (b *Builtin) modelPath() string {
	return filepath.Join(b.CacheDir, "models", ModelRevision[:12], ModelFile)
}
func (b *Builtin) llamaDir() string { return filepath.Join(b.CacheDir, "llama.cpp", LlamaBuild) }

// installed reports whether both files are in place (verified when they were written; Start verifies again).
func (b *Builtin) installed() bool {
	st, err := os.Stat(b.modelPath())
	if err != nil || st.Size() != ModelSize {
		return false
	}
	_, err = os.Stat(filepath.Join(b.llamaDir(), ".verified"))
	return err == nil
}

// Status returns the current state.
func (b *Builtin) Status() BuiltinStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.state
	if s == "" || (s == "not_installed" && b.installed()) {
		if b.installed() {
			s = "stopped"
		} else {
			s = "not_installed"
		}
	}
	a, _ := b.asset()
	total := b.bytesTotal
	if total == 0 {
		total = ModelSize + a.Size
	}
	done := b.bytesDone
	if s != "downloading" {
		done = b.onDisk(a)
	}
	return BuiltinStatus{State: s, Code: b.code, Message: b.message, BytesDone: done, BytesTotal: total}
}

func (b *Builtin) set(state, code, detail string) {
	b.mu.Lock()
	b.state, b.code, b.message = state, code, detail
	b.mu.Unlock()
}

// Download fetches and verifies whatever is missing. It blocks; cancel with CancelDownload or ctx.
func (b *Builtin) Download(ctx context.Context) error {
	a, err := b.asset()
	if err != nil {
		b.set("error", "unsupported", err.Error())
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	b.mu.Lock()
	if b.state == "downloading" {
		b.mu.Unlock()
		cancel()
		return errors.New("already downloading")
	}
	b.state, b.code, b.message, b.cancel = "downloading", "", "", cancel
	b.bytesTotal, b.bytesDone = ModelSize+a.Size, 0
	b.mu.Unlock()
	defer cancel()

	fail := func(err error) error {
		if errors.Is(err, context.Canceled) {
			b.set("not_installed", "paused", "download stopped")
		} else {
			b.set("error", "download_failed", err.Error())
		}
		return err
	}
	// llama.cpp first (small), then the model.
	if _, err := os.Stat(filepath.Join(b.llamaDir(), ".verified")); err != nil {
		archive := filepath.Join(b.CacheDir, "downloads", a.File)
		if err := b.fetch(ctx, llamaURL(a), archive, a.Size, a.SHA256, 0); err != nil {
			return fail(err)
		}
		if err := extract(archive, b.llamaDir()); err != nil {
			return fail(fmt.Errorf("extracting llama.cpp: %w", err))
		}
		if _, err := findServer(b.llamaDir()); err != nil {
			return fail(err)
		}
		if err := os.WriteFile(filepath.Join(b.llamaDir(), ".verified"), []byte(a.SHA256+"\n"), 0o600); err != nil {
			return fail(err)
		}
		_ = os.Remove(archive)
		b.logf("llama.cpp %s (%s) installed", LlamaRelease, LlamaBuild)
	}
	b.mu.Lock()
	b.bytesDone = a.Size
	b.mu.Unlock()
	if st, err := os.Stat(b.modelPath()); err != nil || st.Size() != ModelSize {
		if err := b.fetch(ctx, ModelURL, b.modelPath(), ModelSize, ModelSHA256, a.Size); err != nil {
			return fail(err)
		}
		b.logf("model %s installed", ModelFile)
	}
	b.set("stopped", "", "")
	return nil
}

// onDisk counts what is already downloaded (a paused download keeps its partial files).
func (b *Builtin) onDisk(a LlamaAsset) int64 {
	var n int64
	if _, err := os.Stat(filepath.Join(b.llamaDir(), ".verified")); err == nil {
		n += a.Size
	} else if st, err := os.Stat(filepath.Join(b.CacheDir, "downloads", a.File+".part")); err == nil {
		n += st.Size()
	}
	if st, err := os.Stat(b.modelPath()); err == nil {
		n += st.Size()
	} else if st, err := os.Stat(b.modelPath() + ".part"); err == nil {
		n += st.Size()
	}
	return n
}

// DeletePartial removes what a cancelled download left (the partial model, and llama.cpp when the model is not
// complete), so a cancelled download reads 0 bytes done, unlike a paused one.
func (b *Builtin) DeletePartial() {
	if a, err := b.asset(); err == nil {
		_ = os.Remove(filepath.Join(b.CacheDir, "downloads", a.File+".part"))
	}
	_ = os.Remove(b.modelPath() + ".part")
	if st, err := os.Stat(b.modelPath()); err != nil || st.Size() != ModelSize {
		_ = os.RemoveAll(b.llamaDir())
	}
	b.mu.Lock()
	b.bytesDone, b.state, b.code, b.message = 0, "not_installed", "cancelled", "download cancelled"
	b.mu.Unlock()
}

// CancelDownload stops a running download (the partial file is kept and resumed next time).
func (b *Builtin) CancelDownload() {
	b.mu.Lock()
	if b.cancel != nil {
		b.cancel()
	}
	b.mu.Unlock()
}

// fetch downloads url to dst through dst+".part", resuming with a Range request, then checks size and SHA-256.
// A mismatch deletes the file and fails.
func (b *Builtin) fetch(ctx context.Context, url, dst string, size int64, sum string, offset int64) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	part := dst + ".part"
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	have, _ := f.Seek(0, io.SeekEnd)
	if have > size {
		if err := f.Truncate(0); err != nil {
			return err
		}
		have, _ = f.Seek(0, io.SeekStart)
	}
	if have < size {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "ajwf-player")
		if have > 0 {
			req.Header.Set("Range", "bytes="+strconv.FormatInt(have, 10)+"-")
		}
		resp, err := (&http.Client{Timeout: 0}).Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusPartialContent && have > 0:
		case resp.StatusCode == http.StatusOK:
			if err := f.Truncate(0); err != nil {
				return err
			}
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				return err
			}
			have = 0
		default:
			return fmt.Errorf("download %s: HTTP %d", filepath.Base(dst), resp.StatusCode)
		}
		buf := make([]byte, 1<<20)
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if have+int64(n) > size {
					return fmt.Errorf("download %s: larger than the pinned size", filepath.Base(dst))
				}
				if _, err := f.Write(buf[:n]); err != nil {
					return err
				}
				have += int64(n)
				b.mu.Lock()
				b.bytesDone = offset + have
				b.mu.Unlock()
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				return rerr
			}
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if have != size {
		return fmt.Errorf("download %s: got %d bytes, want %d", filepath.Base(dst), have, size)
	}
	got, err := fileSHA256(part)
	if err != nil {
		return err
	}
	if got != sum {
		_ = os.Remove(part)
		return fmt.Errorf("download %s: SHA-256 mismatch (got %s, pinned %s): refused and deleted", filepath.Base(dst), got, sum)
	}
	return os.Rename(part, dst)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// safeJoin resolves an archive entry name inside dir, refusing absolute paths and any `..` escape.
func safeJoin(dir, name string) (string, error) {
	name = filepath.FromSlash(strings.ReplaceAll(name, "\\", "/"))
	// On Windows `\x` is not absolute (no volume) but is rooted: refuse it too.
	if filepath.IsAbs(name) || filepath.VolumeName(name) != "" || strings.HasPrefix(name, string(filepath.Separator)) {
		return "", fmt.Errorf("archive entry %q is absolute", name)
	}
	p := filepath.Join(dir, name)
	rel, err := filepath.Rel(dir, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("archive entry %q escapes the folder", name)
	}
	return p, nil
}

// extract unpacks a verified .tar.gz or .zip into dir (replacing it). Symlinks must stay inside dir.
func extract(archive, dir string) error {
	tmp := dir + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return err
	}
	var err error
	if strings.HasSuffix(archive, ".zip") {
		err = extractZip(archive, tmp)
	} else {
		err = extractTarGz(archive, tmp)
	}
	if err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	_ = os.RemoveAll(dir)
	return os.Rename(tmp, dir)
}

func writeFile(path string, r io.Reader, mode fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, io.LimitReader(r, 2<<30)); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func extractTarGz(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		p, err := safeJoin(dir, h.Name)
		if err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(p, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			mode := fs.FileMode(0o600)
			if h.Mode&0o111 != 0 {
				mode = 0o700
			}
			if err := writeFile(p, tr, mode); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if filepath.IsAbs(h.Linkname) {
				return fmt.Errorf("archive link %q is absolute", h.Name)
			}
			if _, err := safeJoin(dir, filepath.Join(filepath.Dir(h.Name), h.Linkname)); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
				return err
			}
			if err := os.Symlink(h.Linkname, p); err != nil {
				return err
			}
		default:
			// Hard links, devices and the like are not expected in a release archive: skip them.
		}
	}
}

func extractZip(archive, dir string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, zf := range zr.File {
		p, err := safeJoin(dir, zf.Name)
		if err != nil {
			return err
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(p, 0o700); err != nil {
				return err
			}
			continue
		}
		if !zf.Mode().IsRegular() {
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		err = writeFile(p, rc, 0o700)
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// findServer locates llama-server inside the extracted folder.
func findServer(dir string) (string, error) {
	name := "llama-server"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	var found string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == name && found == "" {
			found = p
		}
		return nil
	})
	if found == "" {
		return "", errors.New("llama-server not found in the llama.cpp archive")
	}
	return found, nil
}

// FreePort returns a free loopback port, never 8080.
func FreePort() (int, error) {
	for i := 0; i < 10; i++ {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return 0, err
		}
		port := l.Addr().(*net.TCPAddr).Port
		l.Close()
		if port != 8080 {
			return port, nil
		}
	}
	return 0, errors.New("no free port")
}

// Start verifies the files and runs llama-server. It returns once the server answers /health.
func (b *Builtin) Start(ctx context.Context) (*OpenAI, error) {
	b.mu.Lock()
	if b.client != nil && b.state == "ready" {
		c := b.client
		b.mu.Unlock()
		return c, nil
	}
	b.mu.Unlock()
	if !b.installed() {
		b.set("not_installed", "", "")
		return nil, errors.New("the built-in model is not downloaded yet")
	}
	b.set("starting", "checking", "checking the model file")
	got, err := fileSHA256(b.modelPath())
	if err != nil || got != ModelSHA256 {
		_ = os.Remove(b.modelPath())
		b.set("not_installed", "hash_mismatch", "the model file did not match its pinned SHA-256 and was deleted")
		return nil, errors.New("model hash mismatch")
	}
	bin, err := findServer(b.llamaDir())
	if err != nil {
		b.set("error", "start_failed", err.Error())
		return nil, err
	}
	port, err := FreePort()
	if err != nil {
		b.set("error", "start_failed", err.Error())
		return nil, err
	}
	key := randomKey()
	keyFile := filepath.Join(b.CacheDir, "run", "llama-api-key")
	if err := os.MkdirAll(filepath.Dir(keyFile), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyFile, []byte(key+"\n"), 0o600); err != nil {
		return nil, err
	}
	args := []string{
		"--model", b.modelPath(),
		"--host", "127.0.0.1", "--port", strconv.Itoa(port),
		"--api-key-file", keyFile,
		"--ctx-size", "8192", "--parallel", "1",
		"--reasoning", "off", "--offline", "--no-webui",
		"--temp", "0.1", "--top-k", "50", "--repeat-penalty", "1.1",
		"--log-disable",
	}
	cmd := exec.Command(bin, args...)
	cmd.Dir = filepath.Dir(bin)
	cmd.Env = append(os.Environ(), "LLAMA_ARG_HOST=127.0.0.1")
	logPath := filepath.Join(b.CacheDir, "run", "llama-server.log")
	if lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		cmd.Stdout, cmd.Stderr = lf, lf
	}
	setProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		b.set("error", "start_failed", "could not start llama-server: "+err.Error())
		return nil, err
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
		b.mu.Lock()
		if b.cmd == cmd {
			b.cmd, b.client = nil, nil
			if b.state == "ready" || b.state == "starting" {
				b.state, b.code, b.message = "error", "stopped", "llama-server stopped unexpectedly (see "+logPath+")"
			}
		}
		b.mu.Unlock()
	}()
	b.mu.Lock()
	b.cmd, b.port, b.key, b.exited = cmd, port, key, exited
	b.mu.Unlock()
	b.set("starting", "loading", "loading the model")
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(3 * time.Minute)
	for {
		select {
		case <-exited:
			return nil, errors.New("llama-server exited while starting (see " + logPath + ")")
		case <-ctx.Done():
			b.Stop()
			return nil, ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
		req, _ := http.NewRequest(http.MethodGet, base+"/health", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			b.Stop()
			b.set("error", "not_ready", "llama-server did not become ready")
			return nil, errors.New("llama-server did not become ready")
		}
	}
	c := &OpenAI{Base: base, APIKey: key, Extras: true, LlamaCpp: true}
	b.mu.Lock()
	b.client, b.state, b.code, b.message = c, "ready", "", ""
	b.mu.Unlock()
	b.logf("llama-server ready on 127.0.0.1:%d (pid %d)", port, cmd.Process.Pid)
	return c, nil
}

// PID of the running llama-server, or 0.
func (b *Builtin) PID() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cmd != nil && b.cmd.Process != nil {
		return b.cmd.Process.Pid
	}
	return 0
}

// Stop ends llama-server (gracefully, then by force after 5 s).
func (b *Builtin) Stop() {
	b.mu.Lock()
	cmd, exited := b.cmd, b.exited
	b.cmd, b.client = nil, nil
	if b.state == "ready" || b.state == "starting" {
		b.state = "stopped"
	}
	b.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	terminate(cmd)
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-exited
	}
	b.logf("llama-server stopped")
}

func randomKey() string {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}
