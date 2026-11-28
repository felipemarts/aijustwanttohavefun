//go:build !windows

package engine

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts llama-server in its own process group so that a terminal Ctrl+C reaches only this program,
// which then stops the server itself.
func setProcessGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

func terminate(cmd *exec.Cmd) { _ = cmd.Process.Signal(syscall.SIGTERM) }
