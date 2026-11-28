//go:build !windows

package awake

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
)

func hold() (func(), error) {
	pid := strconv.Itoa(os.Getpid())
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("/usr/bin/caffeinate", "-i", "-w", pid)
	case "linux":
		inhibit, err := exec.LookPath("systemd-inhibit")
		if err != nil {
			return nil, errors.New("systemd-inhibit not found: the computer may sleep while playing")
		}
		cmd = exec.Command(inhibit, "--what=idle:sleep", "--who=ajwf-player", "--why=Characters are playing", "--mode=block", "tail", "--pid="+pid, "-f", "/dev/null")
	default:
		return nil, errors.New("keep-awake is not supported on " + runtime.GOOS)
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() { _ = cmd.Wait() }()
	return func() { _ = cmd.Process.Kill() }, nil
}
