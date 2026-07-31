// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
)

func TestFocusDetachedCapturesSnapshotOnce(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	placement := &SpatialPlacement{X: 100, Y: 50, Width: 800, Height: 600}
	if _, err := Detach(ctx, blockId, DetachOpts{Placement: placement}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := Focus(ctx, blockId); err != nil {
		t.Fatalf("Focus: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	snap := st.FocusSnapshots[blockId]
	if snap == nil || !snap.WasDetached {
		t.Fatalf("snapshot missing or wrong: %+v", snap)
	}
	if snap.Placement == nil || snap.Placement.X != 100 {
		t.Fatalf("snapshot placement wrong: %+v", snap.Placement)
	}
	if !st.Modules[blockId].IsFocused {
		t.Fatalf("module not focused")
	}

	// El enfoque agranda la ventana y el self-report pisa el placement vivo;
	// un segundo Focus NUNCA debe pisar el snapshot original (CONTRACTS §1).
	if err := Move(ctx, blockId, "", &SpatialPlacement{X: 0, Y: 0, Width: 1600, Height: 900}); err != nil {
		t.Fatalf("Move: %v", err)
	}
	if err := Focus(ctx, blockId); err != nil {
		t.Fatalf("second Focus: %v", err)
	}
	st, _ = GetState(ctx, workspaceId)
	snap = st.FocusSnapshots[blockId]
	if snap.Placement.X != 100 || snap.Placement.Width != 800 {
		t.Fatalf("double focus overwrote original snapshot: %+v", snap.Placement)
	}
}

func TestFocusDockedCreatesEntryAndDockSnapshot(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if err := Focus(ctx, blockId); err != nil {
		t.Fatalf("Focus: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	mi := st.Modules[blockId]
	if mi == nil || mi.IsDetached || !mi.IsFocused {
		t.Fatalf("docked focus entry wrong: %+v", mi)
	}
	snap := st.FocusSnapshots[blockId]
	if snap == nil || snap.WasDetached {
		t.Fatalf("docked snapshot wrong: %+v", snap)
	}
	if snap.Dock == nil || snap.Dock.TabId != tabId {
		t.Fatalf("dock memory not captured: %+v", snap.Dock)
	}
	if !reflect.DeepEqual(snap.Dock.IndexArr, []int{1, 0}) {
		t.Fatalf("dock indexarr = %v, want [1 0]", snap.Dock.IndexArr)
	}
}

func TestFocusIsExclusive(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if _, err := Detach(ctx, blockId, DetachOpts{}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := Focus(ctx, blockId); err != nil {
		t.Fatalf("Focus detached: %v", err)
	}

	block2 := makeSecondBlock(t, ctx, tabId)
	if err := Focus(ctx, block2); err != nil {
		t.Fatalf("Focus second: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if st.Modules[blockId].IsFocused {
		t.Fatalf("first module still focused")
	}
	if !st.Modules[block2].IsFocused {
		t.Fatalf("second module not focused")
	}
}

func TestRestoreConsumesSnapshot(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	placement := &SpatialPlacement{X: 100, Y: 50, Width: 800, Height: 600}
	if _, err := Detach(ctx, blockId, DetachOpts{Placement: placement}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := Focus(ctx, blockId); err != nil {
		t.Fatalf("Focus: %v", err)
	}
	if err := Move(ctx, blockId, "", &SpatialPlacement{X: 0, Y: 0, Width: 1600, Height: 900}); err != nil {
		t.Fatalf("Move: %v", err)
	}
	if err := Restore(ctx, blockId); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if st.FocusSnapshots[blockId] != nil {
		t.Fatalf("snapshot not consumed")
	}
	mi := st.Modules[blockId]
	if mi.IsFocused {
		t.Fatalf("focus flag not cleared")
	}
	if mi.Placement.X != 100 || mi.Placement.Width != 800 {
		t.Fatalf("placement not restored: %+v", mi.Placement)
	}
	if st.Surfaces[mi.CurrentSurfaceId].Bounds.X != 100 {
		t.Fatalf("surface bounds not restored")
	}
}

func TestRestoreDockedRemovesDefaultEntry(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if err := Focus(ctx, blockId); err != nil {
		t.Fatalf("Focus: %v", err)
	}
	if err := Restore(ctx, blockId); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if st.Modules[blockId] != nil {
		t.Fatalf("docked default entry not cleaned: %+v", st.Modules[blockId])
	}
	if st.FocusSnapshots[blockId] != nil {
		t.Fatalf("snapshot not consumed")
	}
}

func TestRestoreWithoutSnapshotIsNoop(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if err := Restore(ctx, blockId); err != nil {
		t.Fatalf("Restore without snapshot must be nil error, got %v", err)
	}
	if _, err := Detach(ctx, blockId, DetachOpts{}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := Restore(ctx, blockId); err != nil {
		t.Fatalf("Restore on detached without snapshot must be nil error, got %v", err)
	}
	st, _ := GetState(ctx, workspaceId)
	if !st.Modules[blockId].IsDetached {
		t.Fatalf("noop restore must not touch detached state")
	}
}

func TestSetMinimizedPersistsFlag(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if err := SetMinimized(ctx, blockId, true); err == nil {
		t.Fatalf("SetMinimized on docked module must fail (out of MVP scope)")
	}

	if _, err := Detach(ctx, blockId, DetachOpts{}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := SetMinimized(ctx, blockId, true); err != nil {
		t.Fatalf("SetMinimized: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	mi := st.Modules[blockId]
	if !mi.IsMinimized || mi.LifecycleState != Lifecycle_Minimized {
		t.Fatalf("minimized flag not persisted: %+v", mi)
	}
	// idempotente
	if err := SetMinimized(ctx, blockId, true); err != nil {
		t.Fatalf("idempotent SetMinimized: %v", err)
	}
	if err := SetMinimized(ctx, blockId, false); err != nil {
		t.Fatalf("SetMinimized false: %v", err)
	}
	st, _ = GetState(ctx, workspaceId)
	mi = st.Modules[blockId]
	if mi.IsMinimized || mi.LifecycleState != Lifecycle_Detached {
		t.Fatalf("minimized flag not cleared: %+v", mi)
	}
}

func makeSecondBlock(t *testing.T, ctx context.Context, tabId string) string {
	t.Helper()
	block, err := wcore.CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}, &waveobj.RuntimeOpts{}, false)
	if err != nil {
		t.Fatalf("CreateBlock second: %v", err)
	}
	return block.OID
}
