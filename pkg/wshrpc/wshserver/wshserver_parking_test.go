// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func setupParkedWorkspace(t *testing.T, ctx context.Context, server *WshServer) (tabId string, blockId string) {
	workspaceId, err := server.WorkspaceCreateCommand(ctx, wshrpc.CommandWorkspaceCreateData{
		Name: "Parking", Icon: "car", Color: "blue", TabName: "t1",
		Blocks: []*waveobj.BlockDef{
			{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}},
		},
	})
	if err != nil {
		t.Fatalf("WorkspaceCreateCommand: %v", err)
	}
	wsObj, err := wcore.GetWorkspace(ctx, workspaceId)
	if err != nil {
		t.Fatalf("getting workspace: %v", err)
	}
	tabId = wsObj.TabIds[0]
	tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if tab == nil || len(tab.BlockIds) != 1 {
		t.Fatalf("expected 1 block in tab, got %+v", tab)
	}
	return tabId, tab.BlockIds[0]
}

func TestParkAndUnparkBlock(t *testing.T) {
	setupTestWStore(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	server := &WshServer{}
	tabId, blockId := setupParkedWorkspace(t, ctx, server)

	if err := server.ParkBlockCommand(ctx, wshrpc.CommandParkBlockData{
		BlockId: blockId, Note: "video para despues"}); err != nil {
		t.Fatalf("ParkBlockCommand: %v", err)
	}
	tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if slices.Contains(tab.BlockIds, blockId) {
		t.Fatalf("parked block still in tab.blockids (GC lo borraría)")
	}
	block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if block == nil {
		t.Fatalf("parked block object must survive")
	}
	if parked, _ := block.Meta[wcore.MetaKey_NexusParked].(bool); !parked {
		t.Fatalf("expected nexus:parked=true, meta=%v", block.Meta)
	}
	if block.Meta[wcore.MetaKey_NexusParkedNote] != "video para despues" {
		t.Fatalf("expected note persisted")
	}

	parked, err := server.ListParkedBlocksCommand(ctx)
	if err != nil || len(parked) != 1 || parked[0].BlockId != blockId {
		t.Fatalf("ListParkedBlocksCommand = %v, %v", parked, err)
	}

	restoredTab, err := server.UnparkBlockCommand(ctx, wshrpc.CommandUnparkBlockData{BlockId: blockId})
	if err != nil {
		t.Fatalf("UnparkBlockCommand: %v", err)
	}
	if restoredTab != tabId {
		t.Fatalf("expected restore into original tab %q, got %q", tabId, restoredTab)
	}
	tab, _ = wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if !slices.Contains(tab.BlockIds, blockId) {
		t.Fatalf("restored block missing from tab.blockids")
	}
	block, _ = wstore.DBGet[*waveobj.Block](ctx, blockId)
	if _, still := block.Meta[wcore.MetaKey_NexusParked]; still {
		t.Fatalf("nexus:parked meta must be cleared on restore")
	}
	layout, _ := wstore.DBGet[*waveobj.LayoutState](ctx, tab.LayoutState)
	if layout == nil || layout.PendingBackendActions == nil {
		t.Fatalf("expected pending layout actions after unpark")
	}
	foundInsert := false
	for _, action := range *layout.PendingBackendActions {
		if action.ActionType == wcore.LayoutActionDataType_Insert && action.BlockId == blockId {
			foundInsert = true
		}
	}
	if !foundInsert {
		t.Fatalf("expected a pending insert action for %q, got %+v", blockId, *layout.PendingBackendActions)
	}

	parked, _ = server.ListParkedBlocksCommand(ctx)
	if len(parked) != 0 {
		t.Fatalf("expected empty parking lot after restore, got %v", parked)
	}
}

func TestUnparkFallsBackToPreferredTabWhenOriginalGone(t *testing.T) {
	setupTestWStore(t)
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	server := &WshServer{}
	_, blockId := setupParkedWorkspace(t, ctx, server)
	otherTabId, otherBlockId := setupParkedWorkspace(t, ctx, server)
	_ = otherBlockId

	if err := server.ParkBlockCommand(ctx, wshrpc.CommandParkBlockData{BlockId: blockId}); err != nil {
		t.Fatalf("ParkBlockCommand: %v", err)
	}
	block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
	block.Meta[wcore.MetaKey_NexusParkedFrom] = "tab-que-no-existe"
	if err := wstore.DBUpdate(ctx, block); err != nil {
		t.Fatalf("DBUpdate: %v", err)
	}

	restoredTab, err := server.UnparkBlockCommand(ctx, wshrpc.CommandUnparkBlockData{
		BlockId: blockId, TabId: otherTabId})
	if err != nil {
		t.Fatalf("UnparkBlockCommand: %v", err)
	}
	if restoredTab != otherTabId {
		t.Fatalf("expected fallback tab %q, got %q", otherTabId, restoredTab)
	}
}
