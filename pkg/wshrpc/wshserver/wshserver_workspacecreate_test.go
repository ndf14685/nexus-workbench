// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// setupTestWStore inicializa el wstore UNA sola vez por proceso: wavebase
// cachea los env vars en la primera llamada, así que re-inicializar desde
// otro test del mismo package apuntaría a un TempDir ya limpiado.
var testWStoreOnce sync.Once
var testWStoreErr error

func setupTestWStore(t *testing.T) {
	testWStoreOnce.Do(func() {
		dataDir, err := os.MkdirTemp("", "wstore-test-data")
		if err != nil {
			testWStoreErr = err
			return
		}
		configDir, err := os.MkdirTemp("", "wstore-test-config")
		if err != nil {
			testWStoreErr = err
			return
		}
		os.Setenv(wavebase.WaveDataHomeEnvVar, dataDir)
		os.Setenv(wavebase.WaveConfigHomeEnvVar, configDir)
		if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
			testWStoreErr = fmt.Errorf("caching env vars: %w", err)
			return
		}
		if err := wavebase.EnsureWaveDBDir(); err != nil {
			testWStoreErr = fmt.Errorf("ensuring db dir: %w", err)
			return
		}
		if err := wstore.InitWStore(); err != nil {
			testWStoreErr = fmt.Errorf("initializing wstore: %w", err)
			return
		}
	})
	if testWStoreErr != nil {
		t.Fatalf("setupTestWStore: %v", testWStoreErr)
	}
}

func TestWorkspaceCreateCommand(t *testing.T) {
	setupTestWStore(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()

	server := &WshServer{}
	_, err := server.WorkspaceCreateCommand(ctx, wshrpc.CommandWorkspaceCreateData{})
	if err == nil {
		t.Fatalf("expected error for empty name")
	}

	data := wshrpc.CommandWorkspaceCreateData{
		Name:    "Ops NexusOS",
		Icon:    "server",
		Color:   "green",
		TabName: "ops",
		Blocks: []*waveobj.BlockDef{
			{Meta: waveobj.MetaMapType{
				waveobj.MetaKey_View:       "term",
				waveobj.MetaKey_Controller: "shell",
				waveobj.MetaKey_Connection: "nexusos-host",
			}},
			{Meta: waveobj.MetaMapType{
				waveobj.MetaKey_View: "preview",
				waveobj.MetaKey_File: "~",
			}},
		},
	}
	workspaceId, err := server.WorkspaceCreateCommand(ctx, data)
	if err != nil {
		t.Fatalf("WorkspaceCreateCommand: %v", err)
	}

	wsObj, err := wcore.GetWorkspace(ctx, workspaceId)
	if err != nil {
		t.Fatalf("getting workspace: %v", err)
	}
	if wsObj.Name != data.Name || wsObj.Icon != data.Icon || wsObj.Color != data.Color {
		t.Errorf("workspace fields = (%q,%q,%q), want (%q,%q,%q)", wsObj.Name, wsObj.Icon, wsObj.Color, data.Name, data.Icon, data.Color)
	}
	if len(wsObj.TabIds) != 1 {
		t.Fatalf("expected 1 tab, got %d", len(wsObj.TabIds))
	}

	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, wsObj.ActiveTabId)
	if err != nil {
		t.Fatalf("getting tab: %v", err)
	}
	if tab.Name != "ops" {
		t.Errorf("tab name = %q, want %q", tab.Name, "ops")
	}
	if len(tab.BlockIds) != len(data.Blocks) {
		t.Fatalf("expected %d blocks, got %d", len(data.Blocks), len(tab.BlockIds))
	}

	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		t.Fatalf("getting block: %v", err)
	}
	if block.Meta.GetString(waveobj.MetaKey_Connection, "") != "nexusos-host" {
		t.Errorf("block connection = %q, want %q", block.Meta.GetString(waveobj.MetaKey_Connection, ""), "nexusos-host")
	}
}
