//go:build windows

package awake

import (
	"runtime"
	"syscall"
)

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

var setThreadExecutionState = syscall.NewLazyDLL("kernel32.dll").NewProc("SetThreadExecutionState")

// hold asks Windows not to sleep from a dedicated OS thread (the request belongs to the thread), until stop.
func hold() (func(), error) {
	if err := setThreadExecutionState.Find(); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	started := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		setThreadExecutionState.Call(uintptr(esContinuous | esSystemRequired))
		close(started)
		<-done
		setThreadExecutionState.Call(uintptr(esContinuous))
	}()
	<-started
	return func() { close(done) }, nil
}
