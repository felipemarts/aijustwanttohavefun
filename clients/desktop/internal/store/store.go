// Package store keeps the program's state on disk: settings, the engine choice, characters with their directives
// and memory, activity logs and chats. Directories are 0700 and files 0600; every write goes through a temporary
// file and a rename, so a crash never leaves half a file.
package store

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
)

// Store is the data directory.
type Store struct {
	Dir string
	mu  sync.Mutex
}

// Open creates the data directory if needed and tightens its permissions.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "characters"), 0o700); err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0o700)
	return &Store{Dir: dir}, nil
}

// WriteJSON writes v as JSON to path (inside the data directory), atomically, mode 0600.
func WriteJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return WriteFile(path, append(b, '\n'))
}

// WriteFile writes atomically with mode 0600.
func WriteFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// ReadJSON reads path into v; a missing file leaves v as is and returns nil.
func ReadJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func (s *Store) path(name string) string { return filepath.Join(s.Dir, name) }

// Load and Save for top-level files (settings.json, engine.json).
func (s *Store) Load(name string, v any) error { return ReadJSON(s.path(name), v) }
func (s *Store) Save(name string, v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return WriteJSON(s.path(name), v)
}

var idRe = regexp.MustCompile(`^[a-z0-9]{8,40}$`)

// CharDir is the folder of one character; ids are checked so that no id can name a path outside it.
func (s *Store) CharDir(id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", fmt.Errorf("bad character id")
	}
	return filepath.Join(s.Dir, "characters", id), nil
}

// CharacterIDs lists the stored characters.
func (s *Store) CharacterIDs() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(s.Dir, "characters"))
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() && idRe.MatchString(e.Name()) {
			if _, err := os.Stat(filepath.Join(s.Dir, "characters", e.Name(), "character.json")); err == nil {
				ids = append(ids, e.Name())
			}
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// RemoveCharacter deletes a character's folder.
func (s *Store) RemoveCharacter(id string) error {
	d, err := s.CharDir(id)
	if err != nil {
		return err
	}
	return os.RemoveAll(d)
}

// AppendLine appends one JSON line to a file in a character's folder (mode 0600).
func (s *Store) AppendLine(id, file string, v any) error {
	d, err := s.CharDir(id)
	if err != nil {
		return err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(d, file), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

// ReadLines reads the last max JSON lines of a character file, calling fn for each in order.
func (s *Store) ReadLines(id, file string, max int, fn func([]byte) error) error {
	d, err := s.CharDir(id)
	if err != nil {
		return err
	}
	f, err := os.Open(filepath.Join(d, file))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	var lines [][]byte
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		lines = append(lines, append([]byte(nil), sc.Bytes()...))
		if len(lines) > 2*max {
			lines = append([][]byte(nil), lines[len(lines)-max:]...)
		}
	}
	if len(lines) > max {
		lines = lines[len(lines)-max:]
	}
	for _, l := range lines {
		if err := fn(l); err != nil {
			return err
		}
	}
	return sc.Err()
}

// RewriteLines replaces a character file with the given values (used to trim a log).
func (s *Store) RewriteLines(id, file string, values []any) error {
	d, err := s.CharDir(id)
	if err != nil {
		return err
	}
	var buf []byte
	for _, v := range values {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		buf = append(append(buf, b...), '\n')
	}
	return WriteFile(filepath.Join(d, file), buf)
}
