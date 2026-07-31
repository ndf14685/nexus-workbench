// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Builds workspace + tab + one real block, with a layout tree that places the
// block at index path [1,0] (size 7) and clears the default-tab leftovers.
func makeTestWorkspaceWithBlock(t *testing.T, ctx context.Context) (workspaceId string, tabId string, blockId string) {
	t.Helper()
	ws, err := wcore.CreateWorkspace(ctx, "spatial-test", "", "", false, false)
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	workspaceId = ws.OID
	tabId = ws.ActiveTabId
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("getting tab: %v", err)
	}
	for _, defaultBlockId := range tab.BlockIds {
		if err := wcore.DeleteBlock(ctx, defaultBlockId, false); err != nil {
			t.Fatalf("deleting default block: %v", err)
		}
	}
	block, err := wcore.CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}, &waveobj.RuntimeOpts{}, false)
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}
	blockId = block.OID
	setTestLayoutTree(t, ctx, tabId, blockId, "")
	return workspaceId, tabId, blockId
}

// Persisted RootNode is raw JSON from the TS LayoutModel, so keys match the
// TS LayoutNode shape (camelCase blockId included).
func setTestLayoutTree(t *testing.T, ctx context.Context, tabId string, blockId string, magnifiedNodeId string) {
	t.Helper()
	layoutStateId, err := wcore.GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		t.Fatalf("GetLayoutIdForTab: %v", err)
	}
	layoutState, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, layoutStateId)
	if err != nil {
		t.Fatalf("getting layout state: %v", err)
	}
	layoutState.RootNode = map[string]any{
		"id":            "node-root",
		"flexDirection": "row",
		"size":          10,
		"children": []any{
			map[string]any{
				"id":   "node-a",
				"size": 5,
				"data": map[string]any{"blockId": "some-other-block"},
			},
			map[string]any{
				"id":            "node-b",
				"flexDirection": "column",
				"size":          5,
				"children": []any{
					map[string]any{
						"id":   "node-leaf",
						"size": 7,
						"data": map[string]any{"blockId": blockId},
					},
				},
			},
		},
	}
	layoutState.MagnifiedNodeId = magnifiedNodeId
	layoutState.PendingBackendActions = nil
	if err := wstore.DBUpdate(ctx, layoutState); err != nil {
		t.Fatalf("updating layout state: %v", err)
	}
}

func getPendingActions(t *testing.T, ctx context.Context, tabId string) []waveobj.LayoutActionData {
	t.Helper()
	layoutStateId, err := wcore.GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		t.Fatalf("GetLayoutIdForTab: %v", err)
	}
	layoutState, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, layoutStateId)
	if err != nil {
		t.Fatalf("getting layout state: %v", err)
	}
	if layoutState.PendingBackendActions == nil {
		return nil
	}
	return *layoutState.PendingBackendActions
}

func clearPendingActions(t *testing.T, ctx context.Context, tabId string) {
	t.Helper()
	layoutStateId, err := wcore.GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		t.Fatalf("GetLayoutIdForTab: %v", err)
	}
	layoutState, err := wstore.DBMustGet[*waveobj.LayoutState](ctx, layoutStateId)
	if err != nil {
		t.Fatalf("getting layout state: %v", err)
	}
	layoutState.PendingBackendActions = nil
	if err := wstore.DBUpdate(ctx, layoutState); err != nil {
		t.Fatalf("updating layout state: %v", err)
	}
}

func TestDetachRegistersInstanceAndQueuesDelete(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	placement := &SpatialPlacement{X: 100, Y: 50, Width: 800, Height: 600}
	surfaceId, err := Detach(ctx, blockId, DetachOpts{Placement: placement, MonitorId: "mon-1"})
	if err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if surfaceId == "" {
		t.Fatalf("expected non-empty surfaceId")
	}

	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	mi := st.Modules[blockId]
	if mi == nil {
		t.Fatalf("expected module instance for %s", blockId)
	}
	if !mi.IsDetached || mi.LifecycleState != Lifecycle_Detached {
		t.Fatalf("module not marked detached: %+v", mi)
	}
	if mi.CurrentSurfaceId != surfaceId {
		t.Fatalf("currentsurfaceid = %q, want %q", mi.CurrentSurfaceId, surfaceId)
	}
	if mi.MonitorId != "mon-1" || mi.Placement == nil || mi.Placement.Width != 800 {
		t.Fatalf("placement/monitor not captured: %+v", mi)
	}
	if mi.PrevDock == nil || mi.PrevDock.TabId != tabId {
		t.Fatalf("prevdock not captured: %+v", mi.PrevDock)
	}
	if !reflect.DeepEqual(mi.PrevDock.IndexArr, []int{1, 0}) {
		t.Fatalf("prevdock indexarr = %v, want [1 0]", mi.PrevDock.IndexArr)
	}
	if mi.PrevDock.NodeSize != 7 {
		t.Fatalf("prevdock nodesize = %d, want 7", mi.PrevDock.NodeSize)
	}
	surf := st.Surfaces[surfaceId]
	if surf == nil || surf.Type != SurfaceType_DetachedWindow || surf.RendererType != RendererType_Desktop {
		t.Fatalf("detached surface wrong: %+v", surf)
	}
	if !reflect.DeepEqual(surf.ModuleIds, []string{blockId}) {
		t.Fatalf("surface moduleids = %v", surf.ModuleIds)
	}
	if mi.PreviousSurfaceId == "" {
		t.Fatalf("expected previoussurfaceid pointing at main surface")
	}
	mainSurf := st.Surfaces[mi.PreviousSurfaceId]
	if mainSurf == nil || mainSurf.Type != SurfaceType_MainWindow {
		t.Fatalf("main surface missing: %+v", mainSurf)
	}

	actions := getPendingActions(t, ctx, tabId)
	if len(actions) != 1 {
		t.Fatalf("expected 1 pending action, got %v", actions)
	}
	if actions[0].ActionType != wcore.LayoutActionDataType_Remove || actions[0].BlockId != blockId {
		t.Fatalf("wrong queued action: %+v", actions[0])
	}
	if actions[0].ActionId == "" {
		t.Fatalf("queued action missing actionid")
	}

	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("getting tab: %v", err)
	}
	if !contains(tab.BlockIds, blockId) {
		t.Fatalf("detach must not remove block from tab.BlockIds: %v", tab.BlockIds)
	}
}

func TestDetachCapturesMagnified(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)
	setTestLayoutTree(t, ctx, tabId, blockId, "node-leaf")

	if _, err := Detach(ctx, blockId, DetachOpts{}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if !st.Modules[blockId].PrevDock.Magnified {
		t.Fatalf("expected prevdock.magnified=true")
	}
}

func TestAttachRoundTripRestores(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	surfaceId, err := Detach(ctx, blockId, DetachOpts{})
	if err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := Attach(ctx, blockId); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	actions := getPendingActions(t, ctx, tabId)
	if len(actions) != 2 {
		t.Fatalf("expected 2 pending actions (delete+insert), got %v", actions)
	}
	insertAction := actions[1]
	if insertAction.ActionType != wcore.LayoutActionDataType_InsertAtIndex {
		t.Fatalf("expected insertatindex, got %+v", insertAction)
	}
	if insertAction.BlockId != blockId {
		t.Fatalf("insert blockid = %q, want %q", insertAction.BlockId, blockId)
	}
	if insertAction.IndexArr == nil || !reflect.DeepEqual(*insertAction.IndexArr, []int{1, 0}) {
		t.Fatalf("insert indexarr = %v, want [1 0]", insertAction.IndexArr)
	}
	if insertAction.NodeSize == nil || *insertAction.NodeSize != 7 {
		t.Fatalf("insert nodesize = %v, want 7", insertAction.NodeSize)
	}

	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if st.Modules[blockId] != nil {
		t.Fatalf("module instance not cleaned: %+v", st.Modules[blockId])
	}
	if st.Surfaces[surfaceId] != nil {
		t.Fatalf("detached surface not cleaned: %+v", st.Surfaces[surfaceId])
	}
	if st.FocusSnapshots[blockId] != nil {
		t.Fatalf("focus snapshot not cleaned")
	}
}

func TestDetachOfDetachedIsMove(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	surfaceId, err := Detach(ctx, blockId, DetachOpts{Placement: &SpatialPlacement{X: 1, Y: 2, Width: 300, Height: 200}})
	if err != nil {
		t.Fatalf("Detach: %v", err)
	}
	st, _ := GetState(ctx, workspaceId)
	surfaceCount := len(st.Surfaces)

	surfaceId2, err := Detach(ctx, blockId, DetachOpts{Placement: &SpatialPlacement{X: 900, Y: 10, Width: 640, Height: 480}, MonitorId: "mon-2"})
	if err != nil {
		t.Fatalf("second Detach: %v", err)
	}
	if surfaceId2 != surfaceId {
		t.Fatalf("move must keep surface: %q != %q", surfaceId2, surfaceId)
	}

	st, err = GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if len(st.Surfaces) != surfaceCount {
		t.Fatalf("surface count changed on move: %d != %d", len(st.Surfaces), surfaceCount)
	}
	mi := st.Modules[blockId]
	if mi.Placement.X != 900 || mi.MonitorId != "mon-2" {
		t.Fatalf("placement/monitor not updated on move: %+v", mi)
	}
	if st.Surfaces[surfaceId].Bounds.X != 900 || st.Surfaces[surfaceId].MonitorId != "mon-2" {
		t.Fatalf("surface bounds not updated on move: %+v", st.Surfaces[surfaceId])
	}
}

func TestAttachOfNonDetachedIsNoop(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	_, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if err := Attach(ctx, blockId); err != nil {
		t.Fatalf("Attach on docked module must be nil error, got %v", err)
	}
	if actions := getPendingActions(t, ctx, tabId); len(actions) != 0 {
		t.Fatalf("no-op attach queued actions: %v", actions)
	}
}

func TestDetachAttachCyclesLeaveCleanState(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	for i := 0; i < 4; i++ {
		if _, err := Detach(ctx, blockId, DetachOpts{}); err != nil {
			t.Fatalf("cycle %d Detach: %v", i, err)
		}
		if err := Attach(ctx, blockId); err != nil {
			t.Fatalf("cycle %d Attach: %v", i, err)
		}
		clearPendingActions(t, ctx, tabId)
	}

	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("getting tab: %v", err)
	}
	if len(tab.BlockIds) != 1 || tab.BlockIds[0] != blockId {
		t.Fatalf("tab.BlockIds = %v, want exactly [%s]", tab.BlockIds, blockId)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if len(st.Modules) != 0 {
		t.Fatalf("leftover module instances: %+v", st.Modules)
	}
	for _, surf := range st.Surfaces {
		if surf.Type == SurfaceType_DetachedWindow {
			t.Fatalf("leftover detached surface: %+v", surf)
		}
	}
}

func TestFindBlockIndexPath(t *testing.T) {
	tree := map[string]any{
		"id": "root",
		"children": []any{
			map[string]any{"id": "a", "data": map[string]any{"blockId": "blk-a"}},
			map[string]any{
				"id": "b",
				"children": []any{
					map[string]any{"id": "b0", "data": map[string]any{"blockId": "blk-b0"}},
					map[string]any{"id": "b1", "data": map[string]any{"blockId": "blk-b1"}},
				},
			},
		},
	}
	if got := findBlockIndexPath(tree, "blk-b1"); !reflect.DeepEqual(got, []int{1, 1}) {
		t.Fatalf("nested path = %v, want [1 1]", got)
	}
	if got := findBlockIndexPath(tree, "blk-a"); !reflect.DeepEqual(got, []int{0}) {
		t.Fatalf("first-level path = %v, want [0]", got)
	}
	if got := findBlockIndexPath(tree, "blk-missing"); got != nil {
		t.Fatalf("missing block path = %v, want nil", got)
	}
	rootLeaf := map[string]any{"id": "solo", "data": map[string]any{"blockId": "blk-solo"}}
	if got := findBlockIndexPath(rootLeaf, "blk-solo"); got == nil || len(got) != 0 {
		t.Fatalf("root leaf path = %v, want empty non-nil", got)
	}
	if got := findBlockIndexPath("garbage", "blk-a"); got != nil {
		t.Fatalf("malformed root path = %v, want nil", got)
	}
	if got := findBlockIndexPath(nil, "blk-a"); got != nil {
		t.Fatalf("nil root path = %v, want nil", got)
	}
	malformed := map[string]any{"id": "root", "children": "not-a-list"}
	if got := findBlockIndexPath(malformed, "blk-a"); got != nil {
		t.Fatalf("malformed children path = %v, want nil", got)
	}
}

func contains(list []string, val string) bool {
	for _, item := range list {
		if item == val {
			return true
		}
	}
	return false
}
