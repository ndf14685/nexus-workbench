// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package blockservice

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/spatial"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func setupTestWStore(t *testing.T) {
	t.Setenv(wavebase.WaveDataHomeEnvVar, t.TempDir())
	t.Setenv(wavebase.WaveConfigHomeEnvVar, t.TempDir())
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("caching env vars: %v", err)
	}
	// wavebase.EnsureWaveDBDir caches per-process, so mkdir directly
	if err := os.MkdirAll(filepath.Join(wavebase.GetWaveDataDir(), wavebase.WaveDBDir), 0700); err != nil {
		t.Fatalf("ensuring db dir: %v", err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatalf("initializing wstore: %v", err)
	}
}

func testCtx(t *testing.T) context.Context {
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancelFn)
	return ctx
}

func makeBlock(t *testing.T, ctx context.Context, tabId string) string {
	t.Helper()
	block, err := wcore.CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}, &waveobj.RuntimeOpts{}, false)
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}
	return block.OID
}

func setLayoutState(t *testing.T, ctx context.Context, tabId string, rootNode any, pending *[]waveobj.LayoutActionData) {
	t.Helper()
	layoutStateId, err := wcore.GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		t.Fatalf("GetLayoutIdForTab: %v", err)
	}
	layoutState, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, layoutStateId)
	if err != nil {
		t.Fatalf("getting layout state: %v", err)
	}
	layoutState.RootNode = rootNode
	layoutState.PendingBackendActions = pending
	if err := wstore.DBUpdate(ctx, layoutState); err != nil {
		t.Fatalf("updating layout state: %v", err)
	}
}

func blockExists(t *testing.T, ctx context.Context, blockId string) bool {
	t.Helper()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		t.Fatalf("DBGet block: %v", err)
	}
	return block != nil
}

func TestCleanupOrphanedBlocksSkipsDetached(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)

	ws, err := wcore.CreateWorkspace(ctx, "guard-test", "", "", false, false)
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	tabId := ws.ActiveTabId
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("getting tab: %v", err)
	}
	for _, defaultBlockId := range tab.BlockIds {
		if err := wcore.DeleteBlock(ctx, defaultBlockId, false); err != nil {
			t.Fatalf("deleting default block: %v", err)
		}
	}

	detachedBlockId := makeBlock(t, ctx, tabId)
	orphanBlockId := makeBlock(t, ctx, tabId)
	dockedBlockId := makeBlock(t, ctx, tabId)
	pendingBlockId := makeBlock(t, ctx, tabId)

	rootNode := map[string]any{
		"id":   "node-root",
		"data": map[string]any{"blockId": dockedBlockId},
	}
	pending := []waveobj.LayoutActionData{
		{ActionType: wcore.LayoutActionDataType_Insert, ActionId: "pend-1", BlockId: pendingBlockId},
	}
	setLayoutState(t, ctx, tabId, rootNode, &pending)

	st, err := spatial.GetOrCreateSpatialState(ctx, ws.OID)
	if err != nil {
		t.Fatalf("GetOrCreateSpatialState: %v", err)
	}
	st.Modules = map[string]*spatial.ModuleInstance{
		detachedBlockId: {
			Id:               detachedBlockId,
			LifecycleState:   spatial.Lifecycle_Detached,
			CurrentSurfaceId: "surf-1",
			IsDetached:       true,
		},
	}
	if err := spatial.SaveSpatialState(ctx, st); err != nil {
		t.Fatalf("SaveSpatialState: %v", err)
	}

	if _, err := BlockServiceInstance.CleanupOrphanedBlocks(ctx, tabId); err != nil {
		t.Fatalf("CleanupOrphanedBlocks: %v", err)
	}

	if !blockExists(t, ctx, detachedBlockId) {
		t.Fatalf("detached block %s must survive cleanup", detachedBlockId)
	}
	if blockExists(t, ctx, orphanBlockId) {
		t.Fatalf("plain orphan %s must be deleted", orphanBlockId)
	}
	if !blockExists(t, ctx, dockedBlockId) {
		t.Fatalf("in-tree block %s must survive cleanup", dockedBlockId)
	}
	if !blockExists(t, ctx, pendingBlockId) {
		t.Fatalf("block %s with pending layout action must survive cleanup", pendingBlockId)
	}

	tab, err = wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("getting tab after cleanup: %v", err)
	}
	found := map[string]bool{}
	for _, blockId := range tab.BlockIds {
		found[blockId] = true
	}
	if !found[detachedBlockId] || found[orphanBlockId] || !found[dockedBlockId] {
		t.Fatalf("tab.BlockIds wrong after cleanup: %v", tab.BlockIds)
	}
}

func TestCleanupOrphanedBlocksNilTreeIsNoop(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)

	ws, err := wcore.CreateWorkspace(ctx, "guard-nil-tree", "", "", false, false)
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	tabId := ws.ActiveTabId
	orphanBlockId := makeBlock(t, ctx, tabId)
	setLayoutState(t, ctx, tabId, nil, nil)

	if _, err := BlockServiceInstance.CleanupOrphanedBlocks(ctx, tabId); err != nil {
		t.Fatalf("CleanupOrphanedBlocks: %v", err)
	}
	if !blockExists(t, ctx, orphanBlockId) {
		t.Fatalf("cleanup must be a no-op when the layout tree is nil")
	}
}
