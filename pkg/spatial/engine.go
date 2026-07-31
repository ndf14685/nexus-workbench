// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const MetaKey_MonitorFill = "monitorfill"

type DetachOpts struct {
	MonitorId string
	Placement *SpatialPlacement
	Fill      bool
}

// Spatial ops serialize per workspace (R2): the PendingBackendActions drain
// has no CAS, so concurrent spatial mutations could drop queued actions.
var engineLock sync.Mutex
var workspaceLocks = make(map[string]*sync.Mutex)

func getWorkspaceLock(workspaceId string) *sync.Mutex {
	engineLock.Lock()
	defer engineLock.Unlock()
	lock := workspaceLocks[workspaceId]
	if lock == nil {
		lock = &sync.Mutex{}
		workspaceLocks[workspaceId] = lock
	}
	return lock
}

func GetState(ctx context.Context, workspaceId string) (*SpatialState, error) {
	return GetOrCreateSpatialState(ctx, workspaceId)
}

func Detach(ctx context.Context, moduleId string, opts DetachOpts) (string, error) {
	if moduleId == "" {
		return "", fmt.Errorf("moduleid is required")
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, moduleId)
	if err != nil {
		return "", fmt.Errorf("finding tab for module %s: %w", moduleId, err)
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return "", fmt.Errorf("finding workspace for tab %s: %w", tabId, err)
	}
	if workspaceId == "" {
		return "", fmt.Errorf("no workspace found for tab %s", tabId)
	}
	lock := getWorkspaceLock(workspaceId)
	lock.Lock()
	defer lock.Unlock()
	st, err := GetOrCreateSpatialState(ctx, workspaceId)
	if err != nil {
		return "", err
	}
	if mi := st.Modules[moduleId]; mi != nil && mi.IsDetached {
		return moveDetached(ctx, st, mi, opts)
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, moduleId)
	if err != nil {
		return "", fmt.Errorf("getting block %s: %w", moduleId, err)
	}
	if block == nil {
		return "", fmt.Errorf("block %s not found", moduleId)
	}
	now := time.Now().UnixMilli()
	dock := captureDockMemory(ctx, tabId, moduleId, now)
	mainSurf := ensureMainSurface(ctx, st, workspaceId, tabId, now)
	surf := &Surface{
		Id:           uuid.NewString(),
		Type:         SurfaceType_DetachedWindow,
		RendererType: RendererType_Desktop,
		Bounds:       opts.Placement,
		MonitorId:    opts.MonitorId,
		ModuleIds:    []string{moduleId},
		CreatedTs:    now,
		UpdatedTs:    now,
	}
	if opts.Fill {
		surf.Meta = waveobj.MetaMapType{MetaKey_MonitorFill: true}
	}
	mi := &ModuleInstance{
		Id:                moduleId,
		Type:              block.Meta.GetString(waveobj.MetaKey_View, ""),
		Title:             block.Meta.GetString(waveobj.MetaKey_FrameTitle, ""),
		LifecycleState:    Lifecycle_Detached,
		CurrentSurfaceId:  surf.Id,
		PreviousSurfaceId: mainSurf.Id,
		Placement:         opts.Placement,
		PrevDock:          dock,
		MonitorId:         opts.MonitorId,
		IsDetached:        true,
		CreatedTs:         now,
		UpdatedTs:         now,
	}
	if st.Modules == nil {
		st.Modules = make(map[string]*ModuleInstance)
	}
	st.Modules[moduleId] = mi
	st.Surfaces[surf.Id] = surf
	// R1: persist the detached mark BEFORE queueing the layout delete so the
	// cleanuporphaned guards already see the module as detached.
	if err := SaveSpatialState(ctx, st); err != nil {
		return "", fmt.Errorf("persisting spatial state: %w", err)
	}
	err = wcore.QueueLayoutActionForTab(ctx, tabId, waveobj.LayoutActionData{
		ActionType: wcore.LayoutActionDataType_Remove,
		BlockId:    moduleId,
	})
	if err != nil {
		return "", fmt.Errorf("queueing layout delete: %w", err)
	}
	publishSpatialEvent(SpatialEventData{
		Type:        SpatialEvent_ModuleDetached,
		WorkspaceId: workspaceId,
		ModuleId:    moduleId,
		SurfaceId:   surf.Id,
		MonitorId:   opts.MonitorId,
	}, surf)
	return surf.Id, nil
}

// Detach on an already-detached module = move (idempotent-friendly,
// CONTRACTS §1): only placement/monitor change, never a second surface.
func moveDetached(ctx context.Context, st *SpatialState, mi *ModuleInstance, opts DetachOpts) (string, error) {
	now := time.Now().UnixMilli()
	if opts.Placement != nil {
		mi.Placement = opts.Placement
	}
	if opts.MonitorId != "" {
		mi.MonitorId = opts.MonitorId
	}
	mi.UpdatedTs = now
	surf := st.Surfaces[mi.CurrentSurfaceId]
	if surf != nil {
		if opts.Placement != nil {
			surf.Bounds = opts.Placement
		}
		if opts.MonitorId != "" {
			surf.MonitorId = opts.MonitorId
		}
		surf.UpdatedTs = now
	}
	if err := SaveSpatialState(ctx, st); err != nil {
		return "", fmt.Errorf("persisting spatial state: %w", err)
	}
	publishSpatialEvent(SpatialEventData{
		Type:        SpatialEvent_ModuleMoved,
		WorkspaceId: st.WorkspaceId,
		ModuleId:    mi.Id,
		SurfaceId:   mi.CurrentSurfaceId,
		MonitorId:   mi.MonitorId,
	}, mi.Placement)
	return mi.CurrentSurfaceId, nil
}

func Attach(ctx context.Context, moduleId string) error {
	if moduleId == "" {
		return fmt.Errorf("moduleid is required")
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, moduleId)
	if err != nil {
		return fmt.Errorf("finding tab for module %s: %w", moduleId, err)
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return fmt.Errorf("finding workspace for tab %s: %w", tabId, err)
	}
	if workspaceId == "" {
		return fmt.Errorf("no workspace found for tab %s", tabId)
	}
	lock := getWorkspaceLock(workspaceId)
	lock.Lock()
	defer lock.Unlock()
	st, err := GetOrCreateSpatialState(ctx, workspaceId)
	if err != nil {
		return err
	}
	mi := st.Modules[moduleId]
	if mi == nil || !mi.IsDetached {
		log.Printf("spatial: attach ignored, module %s is not detached\n", moduleId)
		return nil
	}
	action := waveobj.LayoutActionData{
		ActionType: wcore.LayoutActionDataType_Insert,
		BlockId:    moduleId,
	}
	// Stale IndexArr is fine (R3): the frontend clamps and falls back to a
	// plain insert; the attach never fails because of position.
	if mi.PrevDock != nil {
		if len(mi.PrevDock.IndexArr) > 0 {
			indexArr := mi.PrevDock.IndexArr
			action.ActionType = wcore.LayoutActionDataType_InsertAtIndex
			action.IndexArr = &indexArr
		}
		if mi.PrevDock.NodeSize > 0 {
			nodeSize := mi.PrevDock.NodeSize
			action.NodeSize = &nodeSize
		}
		action.Magnified = mi.PrevDock.Magnified
	}
	if err := wcore.QueueLayoutActionForTab(ctx, tabId, action); err != nil {
		return fmt.Errorf("queueing layout insert: %w", err)
	}
	surfaceId := mi.CurrentSurfaceId
	delete(st.Modules, moduleId)
	delete(st.Surfaces, surfaceId)
	delete(st.FocusSnapshots, moduleId)
	if err := SaveSpatialState(ctx, st); err != nil {
		return fmt.Errorf("persisting spatial state: %w", err)
	}
	publishSpatialEvent(SpatialEventData{
		Type:        SpatialEvent_ModuleAttached,
		WorkspaceId: workspaceId,
		ModuleId:    moduleId,
	}, nil)
	publishSpatialEvent(SpatialEventData{
		Type:        SpatialEvent_SurfaceClosed,
		WorkspaceId: workspaceId,
		ModuleId:    moduleId,
		SurfaceId:   surfaceId,
	}, nil)
	return nil
}

// Best-effort (R3): a module we cannot locate in the tree just re-attaches
// with a plain insert later; capture failures never fail the detach.
func captureDockMemory(ctx context.Context, tabId string, moduleId string, now int64) *DockMemory {
	dock := &DockMemory{TabId: tabId, CapturedTs: now}
	layoutStateId, err := wcore.GetLayoutIdForTab(ctx, tabId)
	if err != nil {
		log.Printf("spatial: dock capture skipped, no layout for tab %s: %v\n", tabId, err)
		return dock
	}
	layoutState, err := wstore.DBGet[*waveobj.LayoutState](ctx, layoutStateId)
	if err != nil || layoutState == nil {
		log.Printf("spatial: dock capture skipped, layout state %s unavailable: %v\n", layoutStateId, err)
		return dock
	}
	dock.IndexArr = findBlockIndexPath(layoutState.RootNode, moduleId)
	leaf := findLeafNode(layoutState.RootNode, moduleId)
	if leaf == nil {
		return dock
	}
	if size, ok := leaf["size"].(float64); ok && size > 0 {
		dock.NodeSize = uint(size)
	}
	if nodeId, ok := leaf["id"].(string); ok && nodeId != "" && nodeId == layoutState.MagnifiedNodeId {
		dock.Magnified = true
	}
	return dock
}

func ensureMainSurface(ctx context.Context, st *SpatialState, workspaceId string, tabId string, now int64) *Surface {
	for _, surf := range st.Surfaces {
		if surf != nil && surf.Type == SurfaceType_MainWindow {
			return surf
		}
	}
	surf := &Surface{
		Id:           uuid.NewString(),
		Type:         SurfaceType_MainWindow,
		RendererType: RendererType_Desktop,
		TabId:        tabId,
		CreatedTs:    now,
		UpdatedTs:    now,
	}
	windowId, err := wstore.DBFindWindowForWorkspaceId(ctx, workspaceId)
	if err == nil {
		surf.WindowId = windowId
	}
	if st.Surfaces == nil {
		st.Surfaces = make(map[string]*Surface)
	}
	st.Surfaces[surf.Id] = surf
	return surf
}

// findBlockIndexPath walks a persisted layout tree (LayoutState.RootNode is
// raw JSON: map[string]any with the TS LayoutNode shape, camelCase "blockId")
// and returns the child-index path to the module's leaf. nil = not found or
// malformed tree; empty path = the root itself is the leaf.
func findBlockIndexPath(rootnode any, blockId string) []int {
	node, ok := rootnode.(map[string]any)
	if !ok {
		return nil
	}
	if leafBlockId(node) == blockId {
		return []int{}
	}
	children, ok := node["children"].([]any)
	if !ok {
		return nil
	}
	for i, child := range children {
		sub := findBlockIndexPath(child, blockId)
		if sub == nil {
			continue
		}
		return append([]int{i}, sub...)
	}
	return nil
}

func findLeafNode(rootnode any, blockId string) map[string]any {
	node, ok := rootnode.(map[string]any)
	if !ok {
		return nil
	}
	if leafBlockId(node) == blockId {
		return node
	}
	children, _ := node["children"].([]any)
	for _, child := range children {
		if leaf := findLeafNode(child, blockId); leaf != nil {
			return leaf
		}
	}
	return nil
}

func leafBlockId(node map[string]any) string {
	data, ok := node["data"].(map[string]any)
	if !ok {
		return ""
	}
	id, _ := data["blockId"].(string)
	return id
}

// CollectTreeBlockIds returns every blockId referenced by the persisted
// layout tree (used by the cleanuporphaned guard, CONTRACTS §6).
func CollectTreeBlockIds(rootnode any) map[string]bool {
	ids := make(map[string]bool)
	collectTreeBlockIds(rootnode, ids)
	return ids
}

func collectTreeBlockIds(rootnode any, ids map[string]bool) {
	node, ok := rootnode.(map[string]any)
	if !ok {
		return
	}
	if id := leafBlockId(node); id != "" {
		ids[id] = true
	}
	children, _ := node["children"].([]any)
	for _, child := range children {
		collectTreeBlockIds(child, ids)
	}
}

func publishSpatialEvent(data SpatialEventData, payload any) {
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err == nil {
			data.Payload = raw
		}
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_SpatialUpdate,
		Scopes: []string{"workspace:" + data.WorkspaceId},
		Data:   data,
	})
}
