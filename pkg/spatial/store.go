// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// GetSpatialStateForWorkspace is the read-only lookup: returns nil (no error)
// when the workspace has no spatial state yet, so callers like the
// cleanuporphaned guard never create state as a side effect.
func GetSpatialStateForWorkspace(ctx context.Context, workspaceId string) (*SpatialState, error) {
	if workspaceId == "" {
		return nil, fmt.Errorf("workspaceid is required")
	}
	states, err := wstore.DBGetAllObjsByType[*waveobj.SpatialState](ctx, waveobj.OType_Spatial)
	if err != nil {
		return nil, fmt.Errorf("loading spatial states: %w", err)
	}
	for _, st := range states {
		if st.WorkspaceId != workspaceId {
			continue
		}
		migrated, changed := MigrateSpatialState(st)
		if changed {
			if err := wstore.DBUpdate(ctx, migrated); err != nil {
				return nil, fmt.Errorf("persisting migrated spatial state: %w", err)
			}
		}
		return migrated, nil
	}
	return nil, nil
}

func GetOrCreateSpatialState(ctx context.Context, workspaceId string) (*SpatialState, error) {
	existing, err := GetSpatialStateForWorkspace(ctx, workspaceId)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}
	st := makeEmptyState(uuid.NewString(), workspaceId)
	if err := wstore.DBInsert(ctx, st); err != nil {
		return nil, fmt.Errorf("inserting spatial state: %w", err)
	}
	return st, nil
}

func SaveSpatialState(ctx context.Context, st *SpatialState) error {
	if st == nil || st.OID == "" {
		return fmt.Errorf("invalid spatial state")
	}
	st.UpdatedTs = time.Now().UnixMilli()
	return wstore.DBUpdate(ctx, st)
}

func DeleteForWorkspace(ctx context.Context, workspaceId string) error {
	if workspaceId == "" {
		return fmt.Errorf("workspaceid is required")
	}
	states, err := wstore.DBGetAllObjsByType[*waveobj.SpatialState](ctx, waveobj.OType_Spatial)
	if err != nil {
		return fmt.Errorf("loading spatial states: %w", err)
	}
	for _, st := range states {
		if st.WorkspaceId != workspaceId {
			continue
		}
		if err := wstore.DBDelete(ctx, waveobj.OType_Spatial, st.OID); err != nil {
			return err
		}
	}
	return nil
}
