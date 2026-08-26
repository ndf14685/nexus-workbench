// Copyright 2026, Nexus
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	winmm         = syscall.NewLazyDLL("winmm.dll")
	procPlaySound = winmm.NewProc("PlaySoundW")
)

const (
	sndAsync     = 0x0001
	sndNodefault = 0x0002
	sndFilename  = 0x00020000
)

func chimeSupported() bool { return winmm.Load() == nil }

// playChimeFile reproduce el wav UNA vez y vuelve enseguida (SND_ASYNC). Sin
// SND_LOOP, asi no hay forma de que quede sonando; y con SND_NODEFAULT, asi si
// el archivo falta no suena el ding por defecto de Windows en su lugar.
func playChimeFile(path string) error {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	r, _, callErr := procPlaySound.Call(uintptr(unsafe.Pointer(p)), 0,
		uintptr(sndFilename|sndAsync|sndNodefault))
	if r == 0 {
		return fmt.Errorf("PlaySound fallo: %v", callErr)
	}
	return nil
}
