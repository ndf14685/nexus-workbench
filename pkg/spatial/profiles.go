// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const ProfilesDirName = "nexus-profiles"
const ProfileSchemaVersion = 1

// Formato DATA_MODEL.md §7. Solo lista blanca CONTRACTS §8: jamás secretos,
// cmd:*, tokens ni contenido de bloques.
type WorkspaceProfile struct {
	SchemaVersion int               `json:"schemaversion"`
	Name          string            `json:"name"`
	CreatedTs     int64             `json:"createdts"`
	UpdatedTs     int64             `json:"updatedts"`
	WorkspaceName string            `json:"workspacename,omitempty"`
	Modules       []*ProfileModule  `json:"modules"`
	Surfaces      []*ProfileSurface `json:"surfaces,omitempty"`
	FocusedModule string            `json:"focusedmodule,omitempty"`
	Panels        *ProfilePanels    `json:"panels,omitempty"`
}

type ProfileModule struct {
	View        string            `json:"view"`
	Title       string            `json:"title,omitempty"`
	Connection  string            `json:"connection,omitempty"`
	File        string            `json:"file,omitempty"`
	Url         string            `json:"url,omitempty"`
	SurfaceType string            `json:"surfacetype"`
	Dock        *ProfileDock      `json:"dock,omitempty"`
	Placement   *SpatialPlacement `json:"placement,omitempty"`
	MonitorId   string            `json:"monitorid,omitempty"`
	Minimized   bool              `json:"minimized,omitempty"`
	Focused     bool              `json:"focused,omitempty"`
}

type ProfileDock struct {
	IndexArr []int `json:"indexarr,omitempty"`
}

type ProfileSurface struct {
	Type      string            `json:"type"`
	Bounds    *SpatialPlacement `json:"bounds,omitempty"`
	MonitorId string            `json:"monitorid,omitempty"`
}

type ProfilePanels struct {
	SidebarVisible bool `json:"sidebarvisible"`
	WidgetsVisible bool `json:"widgetsvisible"`
}

func SlugifyProfileName(name string) string {
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		if r == ' ' || r == '-' {
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
			continue
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
		}
	}
	return strings.TrimSuffix(b.String(), "-")
}

func profilesDir() string {
	return filepath.Join(wavebase.GetWaveConfigDir(), ProfilesDirName)
}

func profilePath(name string) (string, error) {
	slug := SlugifyProfileName(name)
	if slug == "" {
		return "", fmt.Errorf("invalid profile name %q", name)
	}
	return filepath.Join(profilesDir(), slug+".json"), nil
}

func readProfileFile(name string) (*WorkspaceProfile, error) {
	path, err := profilePath(name)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading profile %q: %w", name, err)
	}
	var profile WorkspaceProfile
	if err := json.Unmarshal(raw, &profile); err != nil {
		return nil, fmt.Errorf("parsing profile %q: %w", name, err)
	}
	if profile.SchemaVersion != ProfileSchemaVersion {
		return nil, fmt.Errorf("profile %q has unsupported schemaversion %d", name, profile.SchemaVersion)
	}
	return &profile, nil
}

func writeProfileFile(profile *WorkspaceProfile) error {
	path, err := profilePath(profile.Name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(profilesDir(), 0700); err != nil {
		return fmt.Errorf("creating profiles dir: %w", err)
	}
	raw, err := json.MarshalIndent(profile, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling profile: %w", err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		return fmt.Errorf("writing profile: %w", err)
	}
	return nil
}

// buildProfileModule copia campo-a-campo desde la lista blanca CONTRACTS §8.
// NUNCA serializar block.Meta entero: ahí viven cmd:env, cmd:*, scripts y
// tokens. file/url solo cuando la vista los usa como identidad (preview/web).
func buildProfileModule(block *waveobj.Block, mi *ModuleInstance) *ProfileModule {
	view := block.Meta.GetString(waveobj.MetaKey_View, "")
	pm := &ProfileModule{
		View:        view,
		Title:       block.Meta.GetString(waveobj.MetaKey_FrameTitle, ""),
		Connection:  block.Meta.GetString(waveobj.MetaKey_Connection, ""),
		SurfaceType: SurfaceType_MainWindow,
	}
	if view == "preview" {
		pm.File = block.Meta.GetString(waveobj.MetaKey_File, "")
	}
	if view == "web" {
		pm.Url = block.Meta.GetString(waveobj.MetaKey_Url, "")
	}
	if mi == nil {
		return pm
	}
	pm.Minimized = mi.IsMinimized
	pm.Focused = mi.IsFocused
	if mi.IsDetached {
		pm.SurfaceType = SurfaceType_DetachedWindow
		pm.Placement = mi.Placement
		pm.MonitorId = mi.MonitorId
	}
	return pm
}

func moduleMatchKey(view string, connection string, title string) string {
	return view + "|" + connection + "|" + title
}

// SaveProfile captura el layout espacial del workspace en
// <configdir>/nexus-profiles/<slug>.json. MVP: solo el tab activo (los
// perfiles describen una "escena" de trabajo; multi-tab queda en backlog).
// Idempotente por nombre: guardar dos veces sobreescribe el mismo archivo.
func SaveProfile(ctx context.Context, name string, workspaceId string) error {
	if workspaceId == "" {
		return fmt.Errorf("workspaceid is required")
	}
	if _, err := profilePath(name); err != nil {
		return err
	}
	lock := getWorkspaceLock(workspaceId)
	lock.Lock()
	defer lock.Unlock()

	ws, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		return fmt.Errorf("getting workspace %s: %w", workspaceId, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, ws.ActiveTabId)
	if err != nil {
		return fmt.Errorf("getting active tab: %w", err)
	}
	st, err := GetSpatialStateForWorkspace(ctx, workspaceId)
	if err != nil {
		return err
	}
	var rootNode any
	if layoutStateId, err := wcore.GetLayoutIdForTab(ctx, tab.OID); err == nil {
		if layoutState, err := wstore.DBGet[*waveobj.LayoutState](ctx, layoutStateId); err == nil && layoutState != nil {
			rootNode = layoutState.RootNode
		}
	}

	now := time.Now().UnixMilli()
	profile := &WorkspaceProfile{
		SchemaVersion: ProfileSchemaVersion,
		Name:          name,
		CreatedTs:     now,
		UpdatedTs:     now,
		WorkspaceName: ws.Name,
	}
	if old, err := readProfileFile(name); err == nil && old.CreatedTs > 0 {
		profile.CreatedTs = old.CreatedTs
	}
	for _, blockId := range tab.BlockIds {
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err != nil || block == nil {
			continue
		}
		var mi *ModuleInstance
		if st != nil {
			mi = st.Modules[blockId]
		}
		pm := buildProfileModule(block, mi)
		if pm.SurfaceType == SurfaceType_MainWindow {
			if indexArr := findBlockIndexPath(rootNode, blockId); indexArr != nil {
				pm.Dock = &ProfileDock{IndexArr: indexArr}
			}
		}
		if pm.Focused {
			// focusedmodule referencia por clave declarativa (los blockIds no
			// sobreviven entre máquinas, DATA_MODEL §7)
			profile.FocusedModule = moduleMatchKey(pm.View, pm.Connection, pm.Title)
		}
		profile.Modules = append(profile.Modules, pm)
	}
	if st != nil {
		surfaceIds := make([]string, 0, len(st.Surfaces))
		for surfaceId := range st.Surfaces {
			surfaceIds = append(surfaceIds, surfaceId)
		}
		sort.Strings(surfaceIds)
		for _, surfaceId := range surfaceIds {
			surf := st.Surfaces[surfaceId]
			if surf == nil || surf.Type == SurfaceType_MainWindow {
				continue
			}
			profile.Surfaces = append(profile.Surfaces, &ProfileSurface{
				Type:      surf.Type,
				Bounds:    surf.Bounds,
				MonitorId: surf.MonitorId,
			})
		}
	}
	settings := wconfig.ReadFullConfig().Settings
	sidebarVisible := true
	if settings.NexusSidebarVisible != nil {
		sidebarVisible = *settings.NexusSidebarVisible
	}
	// widgetsvisible best-effort: la barra de widgets de Wave no tiene toggle
	// de visibilidad persistido; se guarda true hasta que exista el setting.
	profile.Panels = &ProfilePanels{SidebarVisible: sidebarVisible, WidgetsVisible: true}

	if err := writeProfileFile(profile); err != nil {
		return err
	}
	publishSpatialEvent(SpatialEventData{
		Type:        SpatialEvent_WorkspaceLayoutSaved,
		WorkspaceId: workspaceId,
	}, map[string]string{"profile": name})
	return nil
}

// LoadProfile aplica un perfil por matching declarativo (view+connection+title,
// con relajación a view+connection): reutiliza bloques existentes moviéndolos
// (Detach/Attach/Move del engine) y crea los faltantes. Los módulos existentes
// que no matchean quedan intactos (la carga destructiva está fuera del MVP).
// focusedmodule y panels se guardan pero no se aplican al cargar (MVP).
// No toma el lock de workspace: cada op del engine ya serializa por sí misma
// (el mutex no es reentrante y las ops internas lo toman).
func LoadProfile(ctx context.Context, name string, workspaceId string) error {
	if workspaceId == "" {
		return fmt.Errorf("workspaceid is required")
	}
	profile, err := readProfileFile(name)
	if err != nil {
		return err
	}
	ws, err := wstore.DBMustGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		return fmt.Errorf("getting workspace %s: %w", workspaceId, err)
	}
	tabId := ws.ActiveTabId
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return fmt.Errorf("getting active tab: %w", err)
	}
	st, err := GetOrCreateSpatialState(ctx, workspaceId)
	if err != nil {
		return err
	}

	type candidate struct {
		blockId    string
		view       string
		connection string
		title      string
		isDetached bool
	}
	var candidates []*candidate
	for _, blockId := range tab.BlockIds {
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err != nil || block == nil {
			continue
		}
		mi := st.Modules[blockId]
		candidates = append(candidates, &candidate{
			blockId:    blockId,
			view:       block.Meta.GetString(waveobj.MetaKey_View, ""),
			connection: block.Meta.GetString(waveobj.MetaKey_Connection, ""),
			title:      block.Meta.GetString(waveobj.MetaKey_FrameTitle, ""),
			isDetached: mi != nil && mi.IsDetached,
		})
	}
	used := make(map[string]bool)
	matchCandidate := func(pm *ProfileModule) *candidate {
		for _, cand := range candidates {
			if !used[cand.blockId] && cand.view == pm.View && cand.connection == pm.Connection && cand.title == pm.Title {
				return cand
			}
		}
		for _, cand := range candidates {
			if !used[cand.blockId] && cand.view == pm.View && cand.connection == pm.Connection {
				return cand
			}
		}
		return nil
	}

	for _, pm := range profile.Modules {
		if pm == nil || pm.View == "" {
			continue
		}
		wantDetached := pm.SurfaceType != SurfaceType_MainWindow
		cand := matchCandidate(pm)
		if cand != nil {
			used[cand.blockId] = true
			if err := applyProfileToExisting(ctx, cand.blockId, cand.isDetached, wantDetached, pm); err != nil {
				return err
			}
			continue
		}
		if err := createProfileModule(ctx, tabId, pm, wantDetached); err != nil {
			return err
		}
	}
	publishSpatialEvent(SpatialEventData{
		Type:        SpatialEvent_WorkspaceLayoutRestored,
		WorkspaceId: workspaceId,
	}, map[string]string{"profile": name})
	return nil
}

func applyProfileToExisting(ctx context.Context, blockId string, isDetached bool, wantDetached bool, pm *ProfileModule) error {
	if wantDetached {
		// Detach de un detached = move (CONTRACTS §1), así que un solo camino
		// cubre acoplado→detached y detached→reposición.
		if _, err := Detach(ctx, blockId, DetachOpts{MonitorId: pm.MonitorId, Placement: pm.Placement}); err != nil {
			return fmt.Errorf("detaching matched module %s: %w", blockId, err)
		}
		if pm.Minimized {
			if err := SetMinimized(ctx, blockId, true); err != nil {
				return fmt.Errorf("minimizing matched module %s: %w", blockId, err)
			}
		}
		return nil
	}
	if isDetached {
		if err := Attach(ctx, blockId); err != nil {
			return fmt.Errorf("attaching matched module %s: %w", blockId, err)
		}
	}
	// Acoplado que sigue acoplado: se deja donde está (reordenar el árbol
	// vigente sería destructivo para el layout actual del usuario).
	return nil
}

func createProfileModule(ctx context.Context, tabId string, pm *ProfileModule, wantDetached bool) error {
	meta := waveobj.MetaMapType{waveobj.MetaKey_View: pm.View}
	if pm.View == "term" {
		meta[waveobj.MetaKey_Controller] = "shell"
	}
	if pm.Title != "" {
		meta[waveobj.MetaKey_FrameTitle] = pm.Title
	}
	if pm.Connection != "" {
		meta[waveobj.MetaKey_Connection] = pm.Connection
	}
	if pm.File != "" {
		meta[waveobj.MetaKey_File] = pm.File
	}
	if pm.Url != "" {
		meta[waveobj.MetaKey_Url] = pm.Url
	}
	block, err := wcore.CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{Meta: meta}, &waveobj.RuntimeOpts{}, false)
	if err != nil {
		return fmt.Errorf("creating module %q: %w", pm.View, err)
	}
	if wantDetached {
		// El bloque nuevo nunca entró al árbol: el delete que encola Detach
		// no encuentra nodo en el frontend y queda en no-op (R3-friendly).
		if _, err := Detach(ctx, block.OID, DetachOpts{MonitorId: pm.MonitorId, Placement: pm.Placement}); err != nil {
			return fmt.Errorf("detaching created module %s: %w", block.OID, err)
		}
		if pm.Minimized {
			if err := SetMinimized(ctx, block.OID, true); err != nil {
				return fmt.Errorf("minimizing created module %s: %w", block.OID, err)
			}
		}
		return nil
	}
	action := waveobj.LayoutActionData{
		ActionType: wcore.LayoutActionDataType_Insert,
		BlockId:    block.OID,
		Focused:    pm.Focused,
	}
	// El frontend clampa IndexArr al árbol vigente y cae a insert simple si la
	// ruta ya no existe (misma semántica que Attach, R3).
	if pm.Dock != nil && len(pm.Dock.IndexArr) > 0 {
		indexArr := pm.Dock.IndexArr
		action.ActionType = wcore.LayoutActionDataType_InsertAtIndex
		action.IndexArr = &indexArr
	}
	if err := wcore.QueueLayoutActionForTab(ctx, tabId, action); err != nil {
		return fmt.Errorf("queueing layout insert for %s: %w", block.OID, err)
	}
	return nil
}

func ListProfiles() ([]string, error) {
	entries, err := os.ReadDir(profilesDir())
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("reading profiles dir: %w", err)
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		names = append(names, strings.TrimSuffix(entry.Name(), ".json"))
	}
	sort.Strings(names)
	return names, nil
}
