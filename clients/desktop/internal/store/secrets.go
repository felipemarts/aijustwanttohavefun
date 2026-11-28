package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"
)

// Secrets holds agent API keys and provider keys: in the OS keychain when there is one (macOS Keychain through
// /usr/bin/security, Windows Credential Manager, the Secret Service on Linux; all reached without cgo), else in a
// 0600 file in the data directory. Secrets never go to logs, the interface or a prompt.
type Secrets interface {
	Get(name string) (string, error)
	Set(name, value string) error
	Delete(name string) error
	Kind() string
}

// ErrNoSecret is returned for a missing secret.
var ErrNoSecret = errors.New("secret not found")

const service = "ajwf-player"

type keychain struct{ prefix string }

func (k keychain) Kind() string { return "keychain" }
func (k keychain) Get(name string) (string, error) {
	v, err := keyring.Get(service, k.prefix+name)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNoSecret
	}
	return v, err
}
func (k keychain) Set(name, value string) error { return keyring.Set(service, k.prefix+name, value) }
func (k keychain) Delete(name string) error {
	err := keyring.Delete(service, k.prefix+name)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

type fileSecrets struct {
	path string
	mu   sync.Mutex
}

func (f *fileSecrets) Kind() string { return "file" }
func (f *fileSecrets) load() (map[string]string, error) {
	m := map[string]string{}
	if err := ReadJSON(f.path, &m); err != nil {
		return nil, err
	}
	return m, nil
}
func (f *fileSecrets) Get(name string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return "", err
	}
	v, ok := m[name]
	if !ok {
		return "", ErrNoSecret
	}
	return v, nil
}
func (f *fileSecrets) Set(name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return err
	}
	m[name] = value
	return WriteJSON(f.path, m)
}
func (f *fileSecrets) Delete(name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return err
	}
	delete(m, name)
	return WriteJSON(f.path, m)
}

// OpenSecrets picks the store: mode "keychain", "file", or "auto" (the keychain when a write and read-back of a probe
// works, else the file). Keychain entries are namespaced by the data directory, so two data directories never share
// keys.
func OpenSecrets(dataDir, mode string) (Secrets, error) {
	sum := sha256.Sum256([]byte(dataDir))
	kc := keychain{prefix: hex.EncodeToString(sum[:6]) + ":"}
	file := &fileSecrets{path: filepath.Join(dataDir, "secrets.json")}
	switch mode {
	case "file":
		return file, nil
	case "keychain":
		return kc, nil
	}
	// auto: an existing file store keeps being used (its keys would otherwise be lost).
	if _, err := os.Stat(file.path); err == nil {
		return file, nil
	}
	if err := kc.Set("probe", "ok"); err == nil {
		if v, err := kc.Get("probe"); err == nil && v == "ok" {
			_ = kc.Delete("probe")
			return kc, nil
		}
	}
	return file, nil
}
