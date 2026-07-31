// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestMovePersistsPlacementAndMonitor(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if _, err := Detach(ctx, blockId, DetachOpts{Placement: &SpatialPlacement{X: 10, Y: 10, Width: 640, Height: 480}, MonitorId: "mon-1"}); err != nil {
		t.Fatalf("Detach: %v", err)
	}

	if err := Move(ctx, blockId, "", &SpatialPlacement{X: 50, Y: 60, Width: 700, Height: 500}); err != nil {
		t.Fatalf("Move placement: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	mi := st.Modules[blockId]
	if mi.Placement.X != 50 || mi.Placement.Height != 500 {
		t.Fatalf("placement not persisted: %+v", mi.Placement)
	}
	if mi.MonitorId != "mon-1" {
		t.Fatalf("placement-only move must keep monitor: %q", mi.MonitorId)
	}
	if st.Surfaces[mi.CurrentSurfaceId].Bounds.X != 50 {
		t.Fatalf("surface bounds not persisted: %+v", st.Surfaces[mi.CurrentSurfaceId].Bounds)
	}

	if err := Move(ctx, blockId, "mon-2", nil); err != nil {
		t.Fatalf("Move monitor: %v", err)
	}
	st, _ = GetState(ctx, workspaceId)
	mi = st.Modules[blockId]
	if mi.MonitorId != "mon-2" {
		t.Fatalf("monitor not persisted: %q", mi.MonitorId)
	}
	if mi.Placement.X != 50 {
		t.Fatalf("monitor-only move must keep placement: %+v", mi.Placement)
	}
	if st.Surfaces[mi.CurrentSurfaceId].MonitorId != "mon-2" {
		t.Fatalf("surface monitor not persisted")
	}
}

func TestMoveOnDockedModuleFails(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	_, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if err := Move(ctx, blockId, "mon-1", nil); err == nil {
		t.Fatalf("Move on docked module must fail")
	}
}

func TestCloseModuleRemovesStateAndBlock(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	surfaceId, err := Detach(ctx, blockId, DetachOpts{})
	if err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := CloseModule(ctx, blockId); err != nil {
		t.Fatalf("CloseModule: %v", err)
	}

	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if st.Modules[blockId] != nil {
		t.Fatalf("module instance not removed")
	}
	if st.Surfaces[surfaceId] != nil {
		t.Fatalf("surface not removed")
	}
	if st.FocusSnapshots[blockId] != nil {
		t.Fatalf("focus snapshot not removed")
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		t.Fatalf("DBGet block: %v", err)
	}
	if block != nil {
		t.Fatalf("block not deleted")
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("getting tab: %v", err)
	}
	if contains(tab.BlockIds, blockId) {
		t.Fatalf("block still referenced by tab: %v", tab.BlockIds)
	}
}

func TestCloseModuleOnDockedFails(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	_, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if err := CloseModule(ctx, blockId); err == nil {
		t.Fatalf("CloseModule on docked module must fail (standard close applies)")
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		t.Fatalf("docked block must survive: %v %v", block, err)
	}
}
