// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package wavebase

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func setTestDataDir(t *testing.T) string {
	t.Helper()
	oldDataHome := DataHome_VarCache
	t.Cleanup(func() {
		DataHome_VarCache = oldDataHome
	})
	dir := t.TempDir()
	DataHome_VarCache = dir
	return dir
}

func TestRuntimeStateRoundtrip(t *testing.T) {
	setTestDataDir(t)
	_, err := ReadRuntimeState()
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected fs.ErrNotExist before write, got %v", err)
	}
	state := RuntimeState{
		Pid:      1234,
		StartTs:  1700000000000,
		Web:      "127.0.0.1:50123",
		Ws:       "127.0.0.1:50124",
		Version:  "v0.17.0-beta.0",
		Protocol: RuntimeProtocolVersion,
	}
	err = WriteRuntimeState(state)
	if err != nil {
		t.Fatalf("WriteRuntimeState: %v", err)
	}
	readState, err := ReadRuntimeState()
	if err != nil {
		t.Fatalf("ReadRuntimeState: %v", err)
	}
	if *readState != state {
		t.Fatalf("roundtrip mismatch: wrote %+v, read %+v", state, *readState)
	}
	RemoveRuntimeState()
	_, err = ReadRuntimeState()
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("expected fs.ErrNotExist after remove, got %v", err)
	}
}

func TestRuntimeStateOverwrite(t *testing.T) {
	setTestDataDir(t)
	err := WriteRuntimeState(RuntimeState{Pid: 1, Web: "127.0.0.1:1"})
	if err != nil {
		t.Fatalf("first write: %v", err)
	}
	err = WriteRuntimeState(RuntimeState{Pid: 2, Web: "127.0.0.1:2"})
	if err != nil {
		t.Fatalf("second write: %v", err)
	}
	readState, err := ReadRuntimeState()
	if err != nil {
		t.Fatalf("ReadRuntimeState: %v", err)
	}
	if readState.Pid != 2 || readState.Web != "127.0.0.1:2" {
		t.Fatalf("expected second write to win, got %+v", readState)
	}
}

func TestLoadOrCreateRuntimeAuthKeyStable(t *testing.T) {
	dir := setTestDataDir(t)
	key1, err := LoadOrCreateRuntimeAuthKey()
	if err != nil {
		t.Fatalf("first LoadOrCreateRuntimeAuthKey: %v", err)
	}
	if key1 == "" {
		t.Fatal("empty authkey generated")
	}
	key2, err := LoadOrCreateRuntimeAuthKey()
	if err != nil {
		t.Fatalf("second LoadOrCreateRuntimeAuthKey: %v", err)
	}
	if key1 != key2 {
		t.Fatalf("authkey not stable across calls: %q vs %q", key1, key2)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, RuntimeAuthKeyFileName))
		if err != nil {
			t.Fatalf("stat authkey file: %v", err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("authkey file perms = %v, want 0600", info.Mode().Perm())
		}
	}
}

func TestLoadOrCreateRuntimeAuthKeyEmptyFileRegenerates(t *testing.T) {
	dir := setTestDataDir(t)
	err := os.WriteFile(filepath.Join(dir, RuntimeAuthKeyFileName), []byte("  \n"), 0600)
	if err != nil {
		t.Fatalf("seed empty file: %v", err)
	}
	key, err := LoadOrCreateRuntimeAuthKey()
	if err != nil {
		t.Fatalf("LoadOrCreateRuntimeAuthKey: %v", err)
	}
	if key == "" {
		t.Fatal("expected regenerated key for empty file")
	}
}
