// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Los monitores viven en Electron, no en wavesrv: emain empuja el catálogo
// vigente (SpatialUpdateMonitorsCommand) al arrancar y en cada cambio de
// displays; el engine lo cachea en memoria, sirve SpatialListMonitorsCommand
// desde el cache y deriva monitor.connected/disconnected del diff entre
// catálogos sucesivos. Así el engine queda libre de Electron.
var monitorCatalogLock sync.Mutex
var monitorCatalog []MonitorInfo

func swapMonitorCatalog(monitors []MonitorInfo) []MonitorInfo {
	monitorCatalogLock.Lock()
	defer monitorCatalogLock.Unlock()
	old := monitorCatalog
	monitorCatalog = monitors
	return old
}

func ListMonitors() []MonitorInfo {
	monitorCatalogLock.Lock()
	defer monitorCatalogLock.Unlock()
	out := make([]MonitorInfo, len(monitorCatalog))
	copy(out, monitorCatalog)
	return out
}

// Diff por conjunto de monitorIds. Gemelos (mismo id compuesto) colapsan en
// una entrada: desenchufar uno del par no genera evento (limitación MVP
// documentada, DATA_MODEL §6).
func diffMonitorCatalogs(oldCatalog []MonitorInfo, newCatalog []MonitorInfo) (connected []MonitorInfo, disconnected []MonitorInfo) {
	oldIds := make(map[string]bool)
	for _, mon := range oldCatalog {
		oldIds[mon.MonitorId] = true
	}
	newIds := make(map[string]bool)
	for _, mon := range newCatalog {
		if newIds[mon.MonitorId] {
			continue
		}
		newIds[mon.MonitorId] = true
		if !oldIds[mon.MonitorId] {
			connected = append(connected, mon)
		}
	}
	seen := make(map[string]bool)
	for _, mon := range oldCatalog {
		if seen[mon.MonitorId] {
			continue
		}
		seen[mon.MonitorId] = true
		if !newIds[mon.MonitorId] {
			disconnected = append(disconnected, mon)
		}
	}
	return connected, disconnected
}

// FindMonitor resuelve monitorId → entrada del catálogo; ante gemelos (id
// compuesto duplicado) desempata por bounds más cercanos a ref (R4).
func FindMonitor(catalog []MonitorInfo, monitorId string, ref *SpatialPlacement) *MonitorInfo {
	var best *MonitorInfo
	bestDist := -1
	for i := range catalog {
		mon := &catalog[i]
		if mon.MonitorId != monitorId {
			continue
		}
		if ref == nil || mon.Bounds == nil {
			if best == nil {
				best = mon
			}
			continue
		}
		dist := absInt(mon.Bounds.X-ref.X) + absInt(mon.Bounds.Y-ref.Y)
		if best == nil || bestDist < 0 || dist < bestDist {
			best = mon
			bestDist = dist
		}
	}
	return best
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func UpdateMonitors(ctx context.Context, monitors []MonitorInfo) error {
	oldCatalog := swapMonitorCatalog(monitors)
	connected, disconnected := diffMonitorCatalogs(oldCatalog, monitors)
	if len(connected) == 0 && len(disconnected) == 0 {
		return nil
	}
	states, err := wstore.DBGetAllObjsByType[*waveobj.SpatialState](ctx, waveobj.OType_Spatial)
	if err != nil {
		return fmt.Errorf("loading spatial states: %w", err)
	}
	for _, st := range states {
		if err := applyMonitorDiffToWorkspace(ctx, st.WorkspaceId, connected, disconnected); err != nil {
			log.Printf("spatial: monitor reconciliation failed for workspace %s: %v\n", st.WorkspaceId, err)
		}
	}
	return nil
}

func applyMonitorDiffToWorkspace(ctx context.Context, workspaceId string, connected []MonitorInfo, disconnected []MonitorInfo) error {
	lock := getWorkspaceLock(workspaceId)
	lock.Lock()
	defer lock.Unlock()
	st, err := GetSpatialStateForWorkspace(ctx, workspaceId)
	if err != nil {
		return err
	}
	if st == nil {
		return nil
	}
	now := time.Now().UnixMilli()
	changed := false
	restoredByMonitor := make(map[string]map[string]*SpatialPlacement)
	for _, mon := range disconnected {
		if reconcileMonitorLoss(st, mon, now) {
			changed = true
		}
	}
	for _, mon := range connected {
		if st.MonitorMemory[mon.MonitorId] == nil {
			continue
		}
		restoredByMonitor[mon.MonitorId] = restoreMonitorMemory(st, mon, now)
		changed = true
	}
	if changed {
		if err := SaveSpatialState(ctx, st); err != nil {
			return fmt.Errorf("persisting spatial state: %w", err)
		}
	}
	for _, mon := range disconnected {
		publishSpatialEvent(SpatialEventData{
			Type:        SpatialEvent_MonitorDisconnected,
			WorkspaceId: workspaceId,
			MonitorId:   mon.MonitorId,
		}, mon)
	}
	for _, mon := range connected {
		for moduleId, placement := range restoredByMonitor[mon.MonitorId] {
			publishSpatialEvent(SpatialEventData{
				Type:        SpatialEvent_ModuleMoved,
				WorkspaceId: workspaceId,
				ModuleId:    moduleId,
				MonitorId:   mon.MonitorId,
			}, placement)
		}
		publishSpatialEvent(SpatialEventData{
			Type:        SpatialEvent_MonitorConnected,
			WorkspaceId: workspaceId,
			MonitorId:   mon.MonitorId,
		}, mon)
	}
	return nil
}

// Módulos del monitor perdido → MonitorId "" + placement copiado a
// MonitorMemory (DATA_MODEL §5); la ventana viva la reubica emain, y el
// placement del módulo se actualizará con su próximo reporte de bounds.
func reconcileMonitorLoss(st *SpatialState, mon MonitorInfo, now int64) bool {
	var mm *MonitorMap
	for moduleId, mi := range st.Modules {
		if mi == nil || !mi.IsDetached || mi.MonitorId != mon.MonitorId {
			continue
		}
		if mm == nil {
			mm = &MonitorMap{
				MonitorId:   mon.MonitorId,
				Bounds:      mon.Bounds,
				ScaleFactor: mon.ScaleFactor,
				Modules:     make(map[string]*SpatialPlacement),
				LostTs:      now,
			}
		}
		mm.Modules[moduleId] = mi.Placement
		mi.MonitorId = ""
		mi.UpdatedTs = now
		if surf := st.Surfaces[mi.CurrentSurfaceId]; surf != nil {
			surf.MonitorId = ""
			surf.UpdatedTs = now
		}
	}
	if mm == nil {
		return false
	}
	if st.MonitorMemory == nil {
		st.MonitorMemory = make(map[string]*MonitorMap)
	}
	st.MonitorMemory[mon.MonitorId] = mm
	return true
}

// Reaparición del monitor: restaura placement/monitor de los módulos que
// siguen detached y sin monitor asignado (un Move explícito posterior gana).
func restoreMonitorMemory(st *SpatialState, mon MonitorInfo, now int64) map[string]*SpatialPlacement {
	mm := st.MonitorMemory[mon.MonitorId]
	if mm == nil {
		return nil
	}
	restored := make(map[string]*SpatialPlacement)
	for moduleId, placement := range mm.Modules {
		mi := st.Modules[moduleId]
		if mi == nil || !mi.IsDetached || mi.MonitorId != "" {
			continue
		}
		if placement != nil {
			mi.Placement = placement
		}
		mi.MonitorId = mon.MonitorId
		mi.UpdatedTs = now
		if surf := st.Surfaces[mi.CurrentSurfaceId]; surf != nil {
			surf.MonitorId = mon.MonitorId
			if placement != nil {
				surf.Bounds = placement
			}
			surf.UpdatedTs = now
		}
		restored[moduleId] = placement
	}
	delete(st.MonitorMemory, mon.MonitorId)
	return restored
}
