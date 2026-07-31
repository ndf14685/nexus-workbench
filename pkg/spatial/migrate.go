// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"encoding/json"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// MigrateSpatialState never fails: unknown schemaversion or corrupt data is
// backed up into Meta[MetaKey_CorruptBackup] and replaced by a fresh empty
// state (spatial state must never block startup).
func MigrateSpatialState(st *waveobj.SpatialState) (*waveobj.SpatialState, bool) {
	if st == nil {
		return makeEmptyState("", ""), true
	}
	if isValidState(st) {
		return st, false
	}
	log.Printf("spatial: recovering invalid state for workspace %s (schemaversion=%d)\n", st.WorkspaceId, st.SchemaVersion)
	fresh := makeEmptyState(st.OID, st.WorkspaceId)
	fresh.Version = st.Version
	backup, err := json.Marshal(st)
	if err == nil {
		fresh.Meta = waveobj.MetaMapType{MetaKey_CorruptBackup: string(backup)}
	}
	return fresh, true
}

func isValidState(st *waveobj.SpatialState) bool {
	if st.SchemaVersion != CurrentSchemaVersion {
		return false
	}
	for id, mod := range st.Modules {
		if mod == nil || mod.Id != id {
			return false
		}
	}
	for id, surf := range st.Surfaces {
		if surf == nil || surf.Id != id {
			return false
		}
	}
	for id, snap := range st.FocusSnapshots {
		if snap == nil || snap.ModuleId != id {
			return false
		}
	}
	for id, mon := range st.MonitorMemory {
		if mon == nil || mon.MonitorId != id {
			return false
		}
	}
	return true
}

func makeEmptyState(oid string, workspaceId string) *waveobj.SpatialState {
	now := time.Now().UnixMilli()
	return &waveobj.SpatialState{
		OID:           oid,
		SchemaVersion: CurrentSchemaVersion,
		WorkspaceId:   workspaceId,
		CreatedTs:     now,
		UpdatedTs:     now,
	}
}
