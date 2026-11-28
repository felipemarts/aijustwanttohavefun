// Package awake keeps the computer from going to sleep while characters play: an idle game stalls when the
// machine sleeps. macOS: a `caffeinate -i -w <pid>` child; Linux: `systemd-inhibit` around a `tail --pid` child,
// when available; Windows: SetThreadExecutionState from a thread kept for the purpose. The children end with this
// process even if it crashes (they watch its PID), and Release stops them at once.
package awake

import "sync"

// Keeper holds or releases the inhibition; safe for concurrent use.
type Keeper struct {
	mu   sync.Mutex
	stop func()
	err  error
}

// Hold starts inhibiting sleep if it is not already; the error, if any, is remembered (best effort).
func (k *Keeper) Hold() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.stop != nil {
		return
	}
	k.stop, k.err = hold()
}

// Release lets the computer sleep again.
func (k *Keeper) Release() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.stop != nil {
		k.stop()
		k.stop = nil
	}
}

// Held reports whether sleep is inhibited now, and the last error.
func (k *Keeper) Held() (bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.stop != nil, k.err
}
