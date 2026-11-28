// Package lock makes sure only one copy of the program plays from a data directory at a time.
package lock

import (
	"errors"
	"os"
	"path/filepath"
)

// ErrHeld means another process holds the lock.
var ErrHeld = errors.New("another ajwf-player is already running with this data directory")

// Lock is a held lock; Release frees it (it is also freed when the process exits).
type Lock struct{ f *os.File }

// Acquire takes the lock file `lock` in dir without waiting.
func Acquire(dir string) (*Lock, error) {
	f, err := os.OpenFile(filepath.Join(dir, "lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := tryLock(f); err != nil {
		f.Close()
		return nil, ErrHeld
	}
	return &Lock{f: f}, nil
}

func (l *Lock) Release() {
	if l != nil && l.f != nil {
		_ = unlock(l.f)
		_ = l.f.Close()
	}
}
