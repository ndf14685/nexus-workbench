// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package spatial

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestSlugifyProfileName(t *testing.T) {
	cases := map[string]string{
		"Incident Response":   "incident-response",
		"  Doble   Espacio  ": "doble-espacio",
		"Año/2026: ¡ops!":     "ao2026-ops",
		"UPPER-lower_9":       "upper-lower9",
		"---":                 "",
	}
	for in, want := range cases {
		if got := SlugifyProfileName(in); got != want {
			t.Errorf("SlugifyProfileName(%q) = %q, want %q", in, got, want)
		}
	}
}

func readProfileRaw(t *testing.T, slug string) []byte {
	t.Helper()
	path := filepath.Join(wavebase.GetWaveConfigDir(), ProfilesDirName, slug+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading profile file %s: %v", path, err)
	}
	return raw
}

func parseProfile(t *testing.T, slug string) *WorkspaceProfile {
	t.Helper()
	var profile WorkspaceProfile
	if err := json.Unmarshal(readProfileRaw(t, slug), &profile); err != nil {
		t.Fatalf("unmarshaling profile: %v", err)
	}
	return &profile
}

func TestSaveProfileWritesFile(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, _ := makeTestWorkspaceWithBlock(t, ctx)

	if err := SaveProfile(ctx, "Incident Response", workspaceId); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	profile := parseProfile(t, "incident-response")
	if profile.SchemaVersion != ProfileSchemaVersion {
		t.Fatalf("schemaversion = %d, want %d", profile.SchemaVersion, ProfileSchemaVersion)
	}
	if profile.Name != "Incident Response" {
		t.Fatalf("name = %q", profile.Name)
	}
	if len(profile.Modules) != 1 {
		t.Fatalf("modules = %+v, want 1 entry", profile.Modules)
	}
	pm := profile.Modules[0]
	if pm.View != "term" || pm.SurfaceType != SurfaceType_MainWindow {
		t.Fatalf("module = %+v", pm)
	}
	if pm.Dock == nil || len(pm.Dock.IndexArr) != 2 || pm.Dock.IndexArr[0] != 1 || pm.Dock.IndexArr[1] != 0 {
		t.Fatalf("dock = %+v, want indexarr [1 0]", pm.Dock)
	}
	if profile.Panels == nil {
		t.Fatalf("expected panels section")
	}
}

func TestSaveProfileWhitelistExcludesSecrets(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, _ := makeTestWorkspaceWithBlock(t, ctx)

	block, err := wcore.CreateBlockWithTelemetry(ctx, tabId, &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View:       "term",
			waveobj.MetaKey_Connection: "ssh-prod",
			"cmd":                      "curl -H 'Authorization: Bearer sekrit-jwt-token'",
			"cmd:env":                  map[string]any{"AWS_SECRET_ACCESS_KEY": "hunter2-secret-value"},
			// token falso: NO debe matchear los patrones del scanner de
			// secretos de verify.sh (ghp_ + 36 chars), solo probar el leak
			"cmd:initscript": "export TOKEN=fake-gh-token-para-test-de-leak",
		},
	}, &waveobj.RuntimeOpts{}, false)
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}
	_ = block

	if err := SaveProfile(ctx, "secretos", workspaceId); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	raw := string(readProfileRaw(t, "secretos"))
	for _, forbidden := range []string{"hunter2-secret-value", "sekrit-jwt-token", "fake-gh-token-para-test-de-leak", "cmd:env", "cmd:initscript", "AWS_SECRET_ACCESS_KEY"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("profile leaks %q:\n%s", forbidden, raw)
		}
	}
	if !strings.Contains(raw, "ssh-prod") {
		t.Fatalf("whitelisted connection missing:\n%s", raw)
	}
}

func TestSaveProfileTwiceOverwritesSameFile(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, _ := makeTestWorkspaceWithBlock(t, ctx)

	if err := SaveProfile(ctx, "Mi Perfil", workspaceId); err != nil {
		t.Fatalf("first SaveProfile: %v", err)
	}
	first := parseProfile(t, "mi-perfil")
	if err := SaveProfile(ctx, "Mi Perfil", workspaceId); err != nil {
		t.Fatalf("second SaveProfile: %v", err)
	}
	second := parseProfile(t, "mi-perfil")
	if second.CreatedTs != first.CreatedTs {
		t.Fatalf("createdts not preserved on overwrite: %d != %d", second.CreatedTs, first.CreatedTs)
	}
	entries, err := os.ReadDir(filepath.Join(wavebase.GetWaveConfigDir(), ProfilesDirName))
	if err != nil {
		t.Fatalf("reading profiles dir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly 1 profile file, got %d", len(entries))
	}
	names, err := ListProfiles()
	if err != nil {
		t.Fatalf("ListProfiles: %v", err)
	}
	if len(names) != 1 || names[0] != "mi-perfil" {
		t.Fatalf("ListProfiles = %v", names)
	}
}

func TestListProfilesEmptyDir(t *testing.T) {
	setupTestWStore(t)
	names, err := ListProfiles()
	if err != nil {
		t.Fatalf("ListProfiles: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("expected empty list, got %v", names)
	}
}

func TestSaveProfileCapturesDetached(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, blockId := makeTestWorkspaceWithBlock(t, ctx)

	placement := &SpatialPlacement{X: 50, Y: 60, Width: 700, Height: 500}
	if _, err := Detach(ctx, blockId, DetachOpts{Placement: placement, MonitorId: "DELL|1920x1080@1"}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if err := SaveProfile(ctx, "detached", workspaceId); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	profile := parseProfile(t, "detached")
	if len(profile.Modules) != 1 {
		t.Fatalf("modules = %+v", profile.Modules)
	}
	pm := profile.Modules[0]
	if pm.SurfaceType != SurfaceType_DetachedWindow {
		t.Fatalf("surfacetype = %q", pm.SurfaceType)
	}
	if pm.Placement == nil || pm.Placement.Width != 700 || pm.MonitorId != "DELL|1920x1080@1" {
		t.Fatalf("placement/monitor not captured: %+v", pm)
	}
	if len(profile.Surfaces) != 1 || profile.Surfaces[0].Type != SurfaceType_DetachedWindow {
		t.Fatalf("surfaces = %+v", profile.Surfaces)
	}
}

func countBlocks(t *testing.T, ctx context.Context, tabId string) int {
	t.Helper()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatalf("getting tab: %v", err)
	}
	return len(tab.BlockIds)
}

func TestLoadProfileCreatesMissingAndIsIdempotent(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, _ := makeTestWorkspaceWithBlock(t, ctx)

	profile := &WorkspaceProfile{
		SchemaVersion: ProfileSchemaVersion,
		Name:          "tres modulos",
		Modules: []*ProfileModule{
			{View: "term", SurfaceType: SurfaceType_MainWindow, Dock: &ProfileDock{IndexArr: []int{1, 0}}},
			{View: "sysinfo", SurfaceType: SurfaceType_MainWindow, Dock: &ProfileDock{IndexArr: []int{0}}},
			{View: "jarvis", SurfaceType: SurfaceType_DetachedWindow,
				Placement: &SpatialPlacement{X: 10, Y: 10, Width: 640, Height: 480}, MonitorId: "mon-x"},
		},
	}
	if err := writeProfileFile(profile); err != nil {
		t.Fatalf("writeProfileFile: %v", err)
	}

	if err := LoadProfile(ctx, "tres modulos", workspaceId); err != nil {
		t.Fatalf("LoadProfile: %v", err)
	}
	if got := countBlocks(t, ctx, tabId); got != 3 {
		t.Fatalf("expected 3 blocks after load, got %d", got)
	}
	st, err := GetState(ctx, workspaceId)
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	detachedCount := 0
	for _, mi := range st.Modules {
		if mi != nil && mi.IsDetached {
			detachedCount++
			if mi.Type != "jarvis" || mi.Placement == nil || mi.Placement.Width != 640 || mi.MonitorId != "mon-x" {
				t.Fatalf("detached module wrong: %+v", mi)
			}
		}
	}
	if detachedCount != 1 {
		t.Fatalf("detached count = %d, want 1", detachedCount)
	}

	if err := LoadProfile(ctx, "tres modulos", workspaceId); err != nil {
		t.Fatalf("second LoadProfile: %v", err)
	}
	if got := countBlocks(t, ctx, tabId); got != 3 {
		t.Fatalf("second load duplicated blocks: %d", got)
	}
	st, _ = GetState(ctx, workspaceId)
	detachedCount = 0
	for _, mi := range st.Modules {
		if mi != nil && mi.IsDetached {
			detachedCount++
		}
	}
	if detachedCount != 1 {
		t.Fatalf("second load detached count = %d, want 1", detachedCount)
	}
}

func TestLoadProfileDetachesMatchedDockedModule(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	profile := &WorkspaceProfile{
		SchemaVersion: ProfileSchemaVersion,
		Name:          "term detached",
		Modules: []*ProfileModule{
			{View: "term", SurfaceType: SurfaceType_DetachedWindow,
				Placement: &SpatialPlacement{X: 5, Y: 5, Width: 800, Height: 600}, MonitorId: "mon-1"},
		},
	}
	if err := writeProfileFile(profile); err != nil {
		t.Fatalf("writeProfileFile: %v", err)
	}
	if err := LoadProfile(ctx, "term detached", workspaceId); err != nil {
		t.Fatalf("LoadProfile: %v", err)
	}
	if got := countBlocks(t, ctx, tabId); got != 1 {
		t.Fatalf("matched load must not create blocks: %d", got)
	}
	st, _ := GetState(ctx, workspaceId)
	mi := st.Modules[blockId]
	if mi == nil || !mi.IsDetached || mi.MonitorId != "mon-1" || mi.Placement == nil || mi.Placement.Width != 800 {
		t.Fatalf("existing block not detached to target: %+v", mi)
	}
}

func TestLoadProfileAttachesMatchedDetachedModule(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, tabId, blockId := makeTestWorkspaceWithBlock(t, ctx)

	if _, err := Detach(ctx, blockId, DetachOpts{}); err != nil {
		t.Fatalf("Detach: %v", err)
	}
	profile := &WorkspaceProfile{
		SchemaVersion: ProfileSchemaVersion,
		Name:          "term docked",
		Modules: []*ProfileModule{
			{View: "term", SurfaceType: SurfaceType_MainWindow, Dock: &ProfileDock{IndexArr: []int{1, 0}}},
		},
	}
	if err := writeProfileFile(profile); err != nil {
		t.Fatalf("writeProfileFile: %v", err)
	}
	if err := LoadProfile(ctx, "term docked", workspaceId); err != nil {
		t.Fatalf("LoadProfile: %v", err)
	}
	if got := countBlocks(t, ctx, tabId); got != 1 {
		t.Fatalf("matched load must not create blocks: %d", got)
	}
	st, _ := GetState(ctx, workspaceId)
	if st.Modules[blockId] != nil {
		t.Fatalf("module still has spatial entry after attach: %+v", st.Modules[blockId])
	}
}

func TestLoadProfileMissingFileFails(t *testing.T) {
	setupTestWStore(t)
	ctx := testCtx(t)
	workspaceId, _, _ := makeTestWorkspaceWithBlock(t, ctx)
	if err := LoadProfile(ctx, "no-existe", workspaceId); err == nil {
		t.Fatalf("expected error for missing profile")
	}
}
