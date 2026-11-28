// Package paths decides where the program keeps its data (per-OS config directory) and its downloads (per-OS
// cache directory).
package paths

import (
	"os"
	"path/filepath"
)

const appDir = "ajwf-player"

// Data returns the data directory: override, else <UserConfigDir>/ajwf-player
// (macOS ~/Library/Application Support, Windows %AppData%, Linux $XDG_CONFIG_HOME or ~/.config).
func Data(override string) (string, error) {
	if override != "" {
		return filepath.Abs(override)
	}
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, appDir), nil
}

// Cache returns the download cache: override, else <UserCacheDir>/ajwf-player
// (macOS ~/Library/Caches, Windows %LocalAppData%, Linux $XDG_CACHE_HOME or ~/.cache).
func Cache(override string) (string, error) {
	if override != "" {
		return filepath.Abs(override)
	}
	d, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, appDir), nil
}
