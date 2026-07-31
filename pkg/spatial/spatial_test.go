// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func setupTestWStore(t *testing.T) {
	t.Setenv(wavebase.WaveDataHomeEnvVar, t.TempDir())
	t.Setenv(wavebase.WaveConfigHomeEnvVar, t.TempDir())
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Fatalf("caching env vars: %v", err)
	}
	// wavebase.EnsureWaveDBDir caches per-process, so mkdir directly (each test gets a fresh temp dir)
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

func TestGetOrCreateSaveReload(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)

	const workspaceId = "ws-test-1"
	st, err := GetOrCreateSpatialState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetOrCreateSpatialState: %v", err)
	}
	if st.OID == "" {
		t.Fatalf("expected non-empty OID")
	}
	if st.WorkspaceId != workspaceId {
		t.Fatalf("workspaceid = %q, want %q", st.WorkspaceId, workspaceId)
	}
	if st.SchemaVersion != CurrentSchemaVersion {
		t.Fatalf("schemaversion = %d, want %d", st.SchemaVersion, CurrentSchemaVersion)
	}

	st.Modules = map[string]*ModuleInstance{
		"blk-1": {
			Id:               "blk-1",
			Type:             "term",
			LifecycleState:   Lifecycle_Detached,
			CurrentSurfaceId: "surf-1",
			IsDetached:       true,
			Placement:        &SpatialPlacement{X: 10, Y: 20, Width: 800, Height: 600},
		},
	}
	st.Surfaces = map[string]*Surface{
		"surf-1": {
			Id:           "surf-1",
			Type:         SurfaceType_DetachedWindow,
			RendererType: RendererType_Desktop,
			ModuleIds:    []string{"blk-1"},
		},
	}
	if err := SaveSpatialState(ctx, st); err != nil {
		t.Fatalf("SaveSpatialState: %v", err)
	}

	reloaded, err := GetOrCreateSpatialState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("reload GetOrCreateSpatialState: %v", err)
	}
	if reloaded.OID != st.OID {
		t.Fatalf("reload created new object: oid %q != %q", reloaded.OID, st.OID)
	}
	mod := reloaded.Modules["blk-1"]
	if mod == nil || !mod.IsDetached || mod.LifecycleState != Lifecycle_Detached {
		t.Fatalf("module blk-1 not persisted correctly: %+v", mod)
	}
	if mod.Placement == nil || mod.Placement.Width != 800 {
		t.Fatalf("placement not persisted: %+v", mod.Placement)
	}
	surf := reloaded.Surfaces["surf-1"]
	if surf == nil || surf.Type != SurfaceType_DetachedWindow {
		t.Fatalf("surface surf-1 not persisted correctly: %+v", surf)
	}

	other, err := GetOrCreateSpatialState(ctx, "ws-test-2")
	if err != nil {
		t.Fatalf("GetOrCreateSpatialState other ws: %v", err)
	}
	if other.OID == st.OID {
		t.Fatalf("expected distinct state per workspace")
	}
	if len(other.Modules) != 0 {
		t.Fatalf("new workspace state should be empty, got %+v", other.Modules)
	}
}

func TestDeleteForWorkspace(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)

	st, err := GetOrCreateSpatialState(ctx, "ws-del")
	if err != nil {
		t.Fatalf("GetOrCreateSpatialState: %v", err)
	}
	if err := DeleteForWorkspace(ctx, "ws-del"); err != nil {
		t.Fatalf("DeleteForWorkspace: %v", err)
	}
	states, err := wstore.DBGetAllObjsByType[*waveobj.SpatialState](ctx, waveobj.OType_Spatial)
	if err != nil {
		t.Fatalf("DBGetAllObjsByType: %v", err)
	}
	for _, s := range states {
		if s.OID == st.OID {
			t.Fatalf("state %s still present after delete", st.OID)
		}
	}
}

func TestMigrateUnknownSchemaVersion(t *testing.T) {
	old := &waveobj.SpatialState{
		OID:           "oid-1",
		SchemaVersion: 99,
		WorkspaceId:   "ws-mig",
		Modules: map[string]*ModuleInstance{
			"blk-1": {Id: "blk-1", IsDetached: true},
		},
	}
	migrated, changed := MigrateSpatialState(old)
	if !changed {
		t.Fatalf("expected changed=true for unknown schemaversion")
	}
	if migrated.OID != old.OID || migrated.WorkspaceId != old.WorkspaceId {
		t.Fatalf("identity not preserved: %+v", migrated)
	}
	if migrated.SchemaVersion != CurrentSchemaVersion {
		t.Fatalf("schemaversion = %d, want %d", migrated.SchemaVersion, CurrentSchemaVersion)
	}
	if len(migrated.Modules) != 0 {
		t.Fatalf("expected empty modules after recovery, got %+v", migrated.Modules)
	}
	backup := migrated.Meta.GetString(MetaKey_CorruptBackup, "")
	if backup == "" {
		t.Fatalf("expected corruptbackup in meta")
	}
}

func TestMigrateCorruptData(t *testing.T) {
	old := &waveobj.SpatialState{
		OID:           "oid-2",
		SchemaVersion: CurrentSchemaVersion,
		WorkspaceId:   "ws-corrupt",
		Modules: map[string]*ModuleInstance{
			"blk-1": nil,
		},
	}
	migrated, changed := MigrateSpatialState(old)
	if !changed {
		t.Fatalf("expected changed=true for corrupt data")
	}
	if migrated.Meta.GetString(MetaKey_CorruptBackup, "") == "" {
		t.Fatalf("expected corruptbackup in meta")
	}
	if len(migrated.Modules) != 0 {
		t.Fatalf("expected empty modules after recovery")
	}
}

func TestMigrateValidStateUntouched(t *testing.T) {
	st := &waveobj.SpatialState{
		OID:           "oid-3",
		SchemaVersion: CurrentSchemaVersion,
		WorkspaceId:   "ws-ok",
		Modules: map[string]*ModuleInstance{
			"blk-1": {Id: "blk-1"},
		},
	}
	migrated, changed := MigrateSpatialState(st)
	if changed {
		t.Fatalf("expected changed=false for valid state")
	}
	if migrated != st {
		t.Fatalf("expected same instance back")
	}
}

func TestGetOrCreateRecoversCorruptPersistedState(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)

	corrupt := &waveobj.SpatialState{
		OID:           "11111111-1111-1111-1111-111111111111",
		SchemaVersion: 42,
		WorkspaceId:   "ws-rec",
		Modules: map[string]*ModuleInstance{
			"blk-x": {Id: "blk-x", IsDetached: true},
		},
	}
	if err := wstore.DBInsert(ctx, corrupt); err != nil {
		t.Fatalf("DBInsert corrupt: %v", err)
	}

	st, err := GetOrCreateSpatialState(ctx, "ws-rec")
	if err != nil {
		t.Fatalf("GetOrCreateSpatialState: %v", err)
	}
	if st.OID != corrupt.OID {
		t.Fatalf("expected recovery in place, got new oid %q", st.OID)
	}
	if st.SchemaVersion != CurrentSchemaVersion || len(st.Modules) != 0 {
		t.Fatalf("state not recovered: %+v", st)
	}
	if st.Meta.GetString(MetaKey_CorruptBackup, "") == "" {
		t.Fatalf("expected corruptbackup in meta")
	}

	reloaded, err := GetOrCreateSpatialState(ctx, "ws-rec")
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.SchemaVersion != CurrentSchemaVersion {
		t.Fatalf("recovery not persisted")
	}
	if reloaded.Meta.GetString(MetaKey_CorruptBackup, "") == "" {
		t.Fatalf("recovery backup not persisted")
	}
}
