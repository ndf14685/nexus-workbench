// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package waveobj

// nexus: spatial workspace persisted state (see nexus/docs/spatial/DATA_MODEL.md).
// Structs live in waveobj (not pkg/spatial) to avoid an import cycle with wstore.

type SpatialState struct {
	OID            string                     `json:"oid"`
	Version        int                        `json:"version"`
	SchemaVersion  int                        `json:"schemaversion"`
	WorkspaceId    string                     `json:"workspaceid"`
	Surfaces       map[string]*Surface        `json:"surfaces,omitempty"`
	Modules        map[string]*ModuleInstance `json:"modules,omitempty"` // key = moduleId = blockId
	FocusSnapshots map[string]*FocusSnapshot  `json:"focussnapshots,omitempty"`
	MonitorMemory  map[string]*MonitorMap     `json:"monitormemory,omitempty"` // key = monitorId ausente
	Meta           MetaMapType                `json:"meta,omitempty"`
	CreatedTs      int64                      `json:"createdts"`
	UpdatedTs      int64                      `json:"updatedts"`
}

func (*SpatialState) GetOType() string {
	return OType_Spatial
}

type ModuleInstance struct {
	Id                string            `json:"id"`   // == blockId
	Type              string            `json:"type"` // meta.view: term|jarvis|sysinfo|preview|web|...
	Title             string            `json:"title,omitempty"`
	LifecycleState    string            `json:"lifecyclestate"`
	CurrentSurfaceId  string            `json:"currentsurfaceid"`
	PreviousSurfaceId string            `json:"previoussurfaceid,omitempty"`
	Placement         *SpatialPlacement `json:"placement,omitempty"` // autoritativo SOLO si isdetached
	PrevDock          *DockMemory       `json:"prevdock,omitempty"`
	MonitorId         string            `json:"monitorid,omitempty"`
	IsDetached        bool              `json:"isdetached,omitempty"`
	IsFocused         bool              `json:"isfocused,omitempty"`
	IsMinimized       bool              `json:"isminimized,omitempty"`
	IsMaximized       bool              `json:"ismaximized,omitempty"`
	ContextBinding    map[string]string `json:"contextbinding,omitempty"`
	CreatedTs         int64             `json:"createdts"`
	UpdatedTs         int64             `json:"updatedts"`
}

type SpatialPlacement struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
	ZIndex int `json:"zindex,omitempty"`
	// Reservados para XR/AR (no usados por DesktopRenderer):
	Z            float64 `json:"z,omitempty"`
	Rotation     *Vec3   `json:"rotation,omitempty"`
	Depth        float64 `json:"depth,omitempty"`
	Anchor       string  `json:"anchor,omitempty"` // world|surface|hand|gaze (reservado)
	SpatialScale float64 `json:"spatialscale,omitempty"`
}

type Vec3 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

type Surface struct {
	Id            string            `json:"id"`
	Type          string            `json:"type"`
	RendererType  string            `json:"renderertype"`
	Bounds        *SpatialPlacement `json:"bounds,omitempty"`
	AvailableArea *SpatialPlacement `json:"availablearea,omitempty"`
	MonitorId     string            `json:"monitorid,omitempty"`
	ScaleFactor   float64           `json:"scalefactor,omitempty"`
	ModuleIds     []string          `json:"moduleids,omitempty"`
	// Solo mainwindow:
	WindowId  string      `json:"windowid,omitempty"`
	TabId     string      `json:"tabid,omitempty"`
	Meta      MetaMapType `json:"meta,omitempty"`
	CreatedTs int64       `json:"createdts"`
	UpdatedTs int64       `json:"updatedts"`
}

type DockMemory struct {
	TabId      string `json:"tabid"`
	IndexArr   []int  `json:"indexarr,omitempty"`
	NodeSize   uint   `json:"nodesize,omitempty"`
	Magnified  bool   `json:"magnified,omitempty"`
	CapturedTs int64  `json:"capturedts"`
}

type FocusSnapshot struct {
	ModuleId    string            `json:"moduleid"`
	WasDetached bool              `json:"wasdetached"`
	Placement   *SpatialPlacement `json:"placement,omitempty"` // si detached
	Dock        *DockMemory       `json:"dock,omitempty"`      // si acoplado
	CapturedTs  int64             `json:"capturedts"`
}

type MonitorMap struct {
	MonitorId   string                       `json:"monitorid"`
	Bounds      *SpatialPlacement            `json:"bounds"`
	ScaleFactor float64                      `json:"scalefactor"`
	Modules     map[string]*SpatialPlacement `json:"modules"` // placement original por moduleId
	LostTs      int64                        `json:"lostts"`
}

// Vive en waveobj (no en pkg/spatial) porque las RPCs de wshrpctypes lo
// referencian y pkg/spatial ciclaría vía spatial→wcore→wshrpc.
type MonitorInfo struct {
	MonitorId   string            `json:"monitorid"`
	DisplayId   int               `json:"displayid"`
	Label       string            `json:"label"`
	Bounds      *SpatialPlacement `json:"bounds"`
	WorkArea    *SpatialPlacement `json:"workarea"`
	ScaleFactor float64           `json:"scalefactor"`
	Primary     bool              `json:"primary"`
	Internal    bool              `json:"internal"`
}
