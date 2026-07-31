// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"reflect"
	"testing"
)

func makeMon(monitorId string, x int, primary bool) MonitorInfo {
	return MonitorInfo{
		MonitorId:   monitorId,
		DisplayId:   x,
		Label:       monitorId,
		Bounds:      &SpatialPlacement{X: x, Y: 0, Width: 1920, Height: 1080},
		WorkArea:    &SpatialPlacement{X: x, Y: 30, Width: 1920, Height: 1050},
		ScaleFactor: 1,
		Primary:     primary,
	}
}

func monitorIds(monitors []MonitorInfo) []string {
	ids := make([]string, 0, len(monitors))
	for _, mon := range monitors {
		ids = append(ids, mon.MonitorId)
	}
	return ids
}

func TestDiffMonitorCatalogs(t *testing.T) {
	monA := makeMon("A|1920x1080@1", 0, true)
	monB := makeMon("B|1920x1080@1", 1920, false)
	monC := makeMon("C|2560x1440@2", 3840, false)

	connected, disconnected := diffMonitorCatalogs(nil, []MonitorInfo{monA, monB})
	if !reflect.DeepEqual(monitorIds(connected), []string{monA.MonitorId, monB.MonitorId}) {
		t.Fatalf("initial catalog connected = %v", monitorIds(connected))
	}
	if len(disconnected) != 0 {
		t.Fatalf("initial catalog disconnected = %v", monitorIds(disconnected))
	}

	connected, disconnected = diffMonitorCatalogs([]MonitorInfo{monA, monB}, []MonitorInfo{monA, monC})
	if !reflect.DeepEqual(monitorIds(connected), []string{monC.MonitorId}) {
		t.Fatalf("connected = %v, want [C]", monitorIds(connected))
	}
	if !reflect.DeepEqual(monitorIds(disconnected), []string{monB.MonitorId}) {
		t.Fatalf("disconnected = %v, want [B]", monitorIds(disconnected))
	}

	connected, disconnected = diffMonitorCatalogs([]MonitorInfo{monA, monB}, []MonitorInfo{monB, monA})
	if len(connected) != 0 || len(disconnected) != 0 {
		t.Fatalf("reorder must be a no-op diff: %v / %v", monitorIds(connected), monitorIds(disconnected))
	}

	// Twins share a monitorId: unplugging one of the pair keeps the id present
	// (documented MVP limitation, the diff is by id set).
	twin := makeMon("T|1920x1080@1", 0, true)
	twin2 := makeMon("T|1920x1080@1", 1920, false)
	connected, disconnected = diffMonitorCatalogs([]MonitorInfo{twin, twin2}, []MonitorInfo{twin})
	if len(connected) != 0 || len(disconnected) != 0 {
		t.Fatalf("twin removal must not report id changes: %v / %v", monitorIds(connected), monitorIds(disconnected))
	}
}

func TestFindMonitorTwinDisambiguation(t *testing.T) {
	twinLeft := makeMon("T|1920x1080@1", 0, true)
	twinRight := makeMon("T|1920x1080@1", 1920, false)
	other := makeMon("O|1024x768@1", -1024, false)
	catalog := []MonitorInfo{other, twinLeft, twinRight}

	got := FindMonitor(catalog, "T|1920x1080@1", &SpatialPlacement{X: 2000, Y: 100, Width: 800, Height: 600})
	if got == nil || got.DisplayId != twinRight.DisplayId {
		t.Fatalf("expected right twin, got %+v", got)
	}
	got = FindMonitor(catalog, "T|1920x1080@1", &SpatialPlacement{X: 10, Y: 10, Width: 800, Height: 600})
	if got == nil || got.DisplayId != twinLeft.DisplayId {
		t.Fatalf("expected left twin, got %+v", got)
	}
	// Sin referencia: primer match estable.
	got = FindMonitor(catalog, "T|1920x1080@1", nil)
	if got == nil || got.DisplayId != twinLeft.DisplayId {
		t.Fatalf("expected first twin without ref, got %+v", got)
	}
	if got := FindMonitor(catalog, "missing", nil); got != nil {
		t.Fatalf("missing monitor must be nil, got %+v", got)
	}
	if got := FindMonitor(nil, "T|1920x1080@1", nil); got != nil {
		t.Fatalf("empty catalog must be nil, got %+v", got)
	}
}

func TestUpdateMonitorsReconciliationAndRestore(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)
	swapMonitorCatalog(nil)

	monA := makeMon("A|1920x1080@1", 0, true)
	monB := makeMon("B|1920x1080@1", 1920, false)
	if err := UpdateMonitors(ctx, []MonitorInfo{monA, monB}); err != nil {
		t.Fatalf("initial UpdateMonitors: %v", err)
	}
	if got := ListMonitors(); len(got) != 2 {
		t.Fatalf("ListMonitors = %v, want 2 entries", monitorIds(got))
	}

	placement := &SpatialPlacement{X: 2000, Y: 100, Width: 800, Height: 600}
	if _, err := Detach(ctx, blockId, DetachOpts{Placement: placement, MonitorId: monB.MonitorId}); err != nil {
		t.Fatalf("Detach: %v", err)
	}

	if err := UpdateMonitors(ctx, []MonitorInfo{monA}); err != nil {
		t.Fatalf("UpdateMonitors on loss: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	mi := st.Modules[blockId]
	if mi.MonitorId != "" {
		t.Fatalf("lost monitor not cleared: %q", mi.MonitorId)
	}
	if st.Surfaces[mi.CurrentSurfaceId].MonitorId != "" {
		t.Fatalf("surface monitor not cleared")
	}
	mm := st.MonitorMemory[monB.MonitorId]
	if mm == nil {
		t.Fatalf("monitor memory not filled: %+v", st.MonitorMemory)
	}
	if mm.Modules[blockId] == nil || mm.Modules[blockId].X != 2000 {
		t.Fatalf("memory placement wrong: %+v", mm.Modules[blockId])
	}
	if mm.ScaleFactor != monB.ScaleFactor || mm.Bounds == nil || mm.Bounds.X != monB.Bounds.X {
		t.Fatalf("memory bounds/scale wrong: %+v", mm)
	}

	// emain repositions the live window to primary and reports new bounds; the
	// memory must keep the original placement for the restore.
	if err := Move(ctx, blockId, monA.MonitorId, &SpatialPlacement{X: 40, Y: 40, Width: 800, Height: 600}); err != nil {
		t.Fatalf("Move after loss: %v", err)
	}

	if err := UpdateMonitors(ctx, []MonitorInfo{monA, monB}); err != nil {
		t.Fatalf("UpdateMonitors on reappear: %v", err)
	}
	st, err = GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	mi = st.Modules[blockId]
	// El módulo fue movido explícitamente a otro monitor mientras B estaba
	// ausente: la restauración no debe pisarlo.
	if mi.MonitorId != monA.MonitorId || mi.Placement.X != 40 {
		t.Fatalf("explicit move must win over restore: %+v", mi)
	}
	if st.MonitorMemory[monB.MonitorId] != nil {
		t.Fatalf("monitor memory not consumed on reappear")
	}
}

func TestUpdateMonitorsRestoresPlacementOnReappear(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)
	swapMonitorCatalog(nil)

	monA := makeMon("A|1920x1080@1", 0, true)
	monB := makeMon("B|1920x1080@1", 1920, false)
	if err := UpdateMonitors(ctx, []MonitorInfo{monA, monB}); err != nil {
		t.Fatalf("initial UpdateMonitors: %v", err)
	}
	placement := &SpatialPlacement{X: 2100, Y: 50, Width: 640, Height: 480}
	if _, err := Detach(ctx, blockId, DetachOpts{Placement: placement, MonitorId: monB.MonitorId}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := UpdateMonitors(ctx, []MonitorInfo{monA}); err != nil {
		t.Fatalf("UpdateMonitors on loss: %v", err)
	}
	if err := UpdateMonitors(ctx, []MonitorInfo{monA, monB}); err != nil {
		t.Fatalf("UpdateMonitors on reappear: %v", err)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	mi := st.Modules[blockId]
	if mi.MonitorId != monB.MonitorId {
		t.Fatalf("monitor not restored: %q", mi.MonitorId)
	}
	if mi.Placement.X != 2100 {
		t.Fatalf("placement not restored: %+v", mi.Placement)
	}
	surf := st.Surfaces[mi.CurrentSurfaceId]
	if surf.MonitorId != monB.MonitorId || surf.Bounds.X != 2100 {
		t.Fatalf("surface not restored: %+v", surf)
	}
	if st.MonitorMemory[monB.MonitorId] != nil {
		t.Fatalf("monitor memory not consumed")
	}
}
