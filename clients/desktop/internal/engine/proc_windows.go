//go:build windows

package engine

import (
	"os/exec"
	"syscall"
)

const createNewProcessGroup = 0x00000200

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup, HideWindow: true}
}

// terminate: Windows has no SIGTERM for console processes we do not share a console with; kill it.
func terminate(cmd *exec.Cmd) { _ = cmd.Process.Kill() }
