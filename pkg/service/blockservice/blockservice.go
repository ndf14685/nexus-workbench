// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockservice

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/spatial"
	"github.com/wavetermdev/waveterm/pkg/tsgen/tsgenmeta"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type BlockService struct{}

const DefaultTimeout = 2 * time.Second

var BlockServiceInstance = &BlockService{}

func (bs *BlockService) SendCommand_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		Desc:     "send command to block",
		ArgNames: []string{"blockid", "cmd"},
	}
}

func (bs *BlockService) GetControllerStatus(ctx context.Context, blockId string) (*blockcontroller.BlockControllerRuntimeStatus, error) {
	return blockcontroller.GetBlockControllerRuntimeStatus(blockId), nil
}

func (*BlockService) SaveTerminalState_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		Desc:     "save the terminal state to a blockfile",
		ArgNames: []string{"ctx", "blockId", "state", "stateType", "ptyOffset", "termSize"},
	}
}

func (bs *BlockService) SaveTerminalState(ctx context.Context, blockId string, state string, stateType string, ptyOffset int64, termSize waveobj.TermSize) error {
	_, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return err
	}
	if stateType != "full" && stateType != "preview" {
		return fmt.Errorf("invalid state type: %q", stateType)
	}
	// ignore MakeFile error (already exists is ok)
	filestore.WFS.MakeFile(ctx, blockId, "cache:term:"+stateType, nil, wshrpc.FileOpts{})
	err = filestore.WFS.WriteFile(ctx, blockId, "cache:term:"+stateType, []byte(state))
	if err != nil {
		return fmt.Errorf("cannot save terminal state: %w", err)
	}
	fileMeta := wshrpc.FileMeta{
		"ptyoffset": ptyOffset,
		"termsize":  termSize,
	}
	err = filestore.WFS.WriteMeta(ctx, blockId, "cache:term:"+stateType, fileMeta, true)
	if err != nil {
		return fmt.Errorf("cannot save terminal state meta: %w", err)
	}
	return nil
}

func (*BlockService) CleanupOrphanedBlocks_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		Desc:     "queue a layout action to cleanup orphaned blocks in the tab",
		ArgNames: []string{"ctx", "tabId"},
	}
}

func (bs *BlockService) CleanupOrphanedBlocks(ctx context.Context, tabId string) (waveobj.UpdatesRtnType, error) {
	ctx = waveobj.ContextWithUpdates(ctx)
	// nexus: delete orphans server-side with the spatial guard (CONTRACTS §6)
	// before queueing the frontend sweep — a detached module lives in
	// tab.BlockIds but outside the layout tree ON PURPOSE and must survive.
	cleanupOrphanedTabBlocks(ctx, tabId)
	layoutAction := waveobj.LayoutActionData{
		ActionType: wcore.LayoutActionDataType_CleanupOrphaned,
		ActionId:   uuid.NewString(),
	}
	err := wcore.QueueLayoutActionForTab(ctx, tabId, layoutAction)
	if err != nil {
		return nil, fmt.Errorf("error queuing cleanup layout action: %w", err)
	}
	return waveobj.ContextGetUpdatesRtn(ctx), nil
}

// nexus: server-side counterpart of layoutModel.cleanupOrphanedBlocks. An
// orphan is a blockId in tab.BlockIds that neither the persisted layout tree
// nor any pending layout action references. Spatially-detached modules are
// skipped (CONTRACTS §6); a failed SpatialState load logs and behaves as
// before (orphans deleted). Best-effort: never fails the cleanup call.
func cleanupOrphanedTabBlocks(ctx context.Context, tabId string) {
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil {
		log.Printf("CleanupOrphanedBlocks: cannot load tab %s: %v\n", tabId, err)
		return
	}
	layoutStateId, err := wcore.GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		log.Printf("CleanupOrphanedBlocks: cannot resolve layout for tab %s: %v\n", tabId, err)
		return
	}
	layoutState, err := wstore.DBGet[*waveobj.LayoutState](ctx, layoutStateId)
	if err != nil || layoutState == nil {
		log.Printf("CleanupOrphanedBlocks: cannot load layout state %s: %v\n", layoutStateId, err)
		return
	}
	// mirror the frontend: a nil tree means "not initialized", not "empty"
	if layoutState.RootNode == nil {
		return
	}
	referenced := spatial.CollectTreeBlockIds(layoutState.RootNode)
	if layoutState.PendingBackendActions != nil {
		for _, action := range *layoutState.PendingBackendActions {
			if action.BlockId != "" {
				referenced[action.BlockId] = true
			}
		}
	}
	detachedIds := getDetachedModuleIds(ctx, tabId)
	for _, blockId := range tab.BlockIds {
		if referenced[blockId] || detachedIds[blockId] {
			continue
		}
		log.Printf("CleanupOrphanedBlocks: deleting orphaned block %s in tab %s\n", blockId, tabId)
		if err := wcore.DeleteBlock(ctx, blockId, false); err != nil {
			log.Printf("CleanupOrphanedBlocks: error deleting block %s: %v\n", blockId, err)
		}
	}
}

func getDetachedModuleIds(ctx context.Context, tabId string) map[string]bool {
	detachedIds := make(map[string]bool)
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil || workspaceId == "" {
		log.Printf("CleanupOrphanedBlocks: cannot resolve workspace for tab %s: %v\n", tabId, err)
		return detachedIds
	}
	st, err := spatial.GetSpatialStateForWorkspace(ctx, workspaceId)
	if err != nil {
		log.Printf("CleanupOrphanedBlocks: cannot load spatial state for workspace %s: %v\n", workspaceId, err)
		return detachedIds
	}
	if st == nil {
		return detachedIds
	}
	for moduleId, mod := range st.Modules {
		if mod != nil && mod.IsDetached {
			detachedIds[moduleId] = true
		}
	}
	return detachedIds
}
