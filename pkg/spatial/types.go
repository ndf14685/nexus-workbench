// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"encoding/json"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const CurrentSchemaVersion = 1

const MetaKey_CorruptBackup = "corruptbackup"

const (
	SurfaceType_MainWindow     = "mainwindow"
	SurfaceType_DetachedWindow = "detachedwindow"
	SurfaceType_Monitor        = "monitor"
	// Reservados (no implementados en el MVP):
	SurfaceType_Web    = "web"
	SurfaceType_XR     = "xr"
	SurfaceType_AR     = "ar"
	SurfaceType_Remote = "remote"
)

const (
	RendererType_Desktop = "desktop"
	// Reservados:
	RendererType_Web = "web"
	RendererType_XR  = "xr"
	RendererType_AR  = "ar"
)

const (
	Lifecycle_Created   = "created"
	Lifecycle_Active    = "active"
	Lifecycle_Detached  = "detached"
	Lifecycle_Minimized = "minimized"
	Lifecycle_Closed    = "closed"
)

// SpatialEventData.Type values (CONTRACTS.md §2)
const (
	SpatialEvent_ModuleCreated           = "module.created"
	SpatialEvent_ModuleClosed            = "module.closed"
	SpatialEvent_ModuleDetached          = "module.detached"
	SpatialEvent_ModuleAttached          = "module.attached"
	SpatialEvent_ModuleMoved             = "module.moved"
	SpatialEvent_ModuleResized           = "module.resized"
	SpatialEvent_ModuleFocused           = "module.focused"
	SpatialEvent_ModuleFocusReleased     = "module.focusReleased"
	// Extensión al contrato §2: SetMinimized necesita su propio tipo de evento
	// (module.moved implicaría bounds); payload {minimized:bool}.
	SpatialEvent_ModuleMinimized = "module.minimized"
	SpatialEvent_ModuleSurfaceChanged    = "module.surfaceChanged"
	SpatialEvent_SurfaceCreated          = "surface.created"
	SpatialEvent_SurfaceClosed           = "surface.closed"
	SpatialEvent_MonitorConnected        = "monitor.connected"
	SpatialEvent_MonitorDisconnected     = "monitor.disconnected"
	SpatialEvent_WorkspaceLayoutSaved    = "workspace.layoutSaved"
	SpatialEvent_WorkspaceLayoutRestored = "workspace.layoutRestored"
	SpatialEvent_ContextChanged          = "context.changed"
	SpatialEvent_JarvisCommandReceived   = "jarvis.commandReceived"
)

// Persisted structs live in pkg/waveobj (wtypespatial.go) to avoid an import
// cycle; these aliases keep pkg/spatial as the canonical API surface.
type (
	SpatialState     = waveobj.SpatialState
	ModuleInstance   = waveobj.ModuleInstance
	SpatialPlacement = waveobj.SpatialPlacement
	Vec3             = waveobj.Vec3
	Surface          = waveobj.Surface
	DockMemory       = waveobj.DockMemory
	FocusSnapshot    = waveobj.FocusSnapshot
	MonitorMap       = waveobj.MonitorMap
	MonitorInfo      = waveobj.MonitorInfo
)

type SpatialEventData struct {
	Type        string          `json:"type"`
	WorkspaceId string          `json:"workspaceid"`
	ModuleId    string          `json:"moduleid,omitempty"`
	SurfaceId   string          `json:"surfaceid,omitempty"`
	MonitorId   string          `json:"monitorid,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
}

