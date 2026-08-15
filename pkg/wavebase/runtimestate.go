// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package wavebase

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// Detached runtime rendezvous (ADR-0006). runtime.json publishes the ephemeral
// listener addresses so a client (Electron) starting later can attach; the
// authkey persists across runtime restarts so clients can authenticate without
// having spawned the process themselves.

const RuntimeProtocolVersion = 1
const RuntimeStateFileName = "runtime.json"
const RuntimeAuthKeyFileName = "runtime.authkey"

type RuntimeState struct {
	Pid      int    `json:"pid"`
	StartTs  int64  `json:"startts"`
	Web      string `json:"web"`
	Ws       string `json:"ws"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
}

func runtimeStatePath() string {
	return filepath.Join(GetWaveDataDir(), RuntimeStateFileName)
}

func runtimeAuthKeyPath() string {
	return filepath.Join(GetWaveDataDir(), RuntimeAuthKeyFileName)
}

// atomic write: a client polling runtime.json must never observe a partial file
func WriteRuntimeState(state RuntimeState) error {
	barr, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("cannot marshal runtime state: %w", err)
	}
	statePath := runtimeStatePath()
	tempPath := statePath + ".tmp"
	err = os.WriteFile(tempPath, barr, 0600)
	if err != nil {
		return fmt.Errorf("cannot write runtime state temp file: %w", err)
	}
	err = os.Rename(tempPath, statePath)
	if err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("cannot rename runtime state file: %w", err)
	}
	return nil
}

func ReadRuntimeState() (*RuntimeState, error) {
	barr, err := os.ReadFile(runtimeStatePath())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read runtime state file: %w", err)
	}
	var state RuntimeState
	err = json.Unmarshal(barr, &state)
	if err != nil {
		return nil, fmt.Errorf("cannot parse runtime state file: %w", err)
	}
	return &state, nil
}

func RemoveRuntimeState() {
	os.Remove(runtimeStatePath())
}

func LoadOrCreateRuntimeAuthKey() (string, error) {
	keyPath := runtimeAuthKeyPath()
	barr, err := os.ReadFile(keyPath)
	if err == nil {
		key := strings.TrimSpace(string(barr))
		if key != "" {
			return key, nil
		}
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("cannot read runtime authkey file: %w", err)
	}
	key := uuid.New().String()
	err = os.WriteFile(keyPath, []byte(key), 0600)
	if err != nil {
		return "", fmt.Errorf("cannot write runtime authkey file: %w", err)
	}
	return key, nil
}
