// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Visual Sources: abstracción genérica de una fuente visual del host (una
// capturadora UVC, un monitor, una ventana, un stream remoto). El Workbench es
// un CONSUMIDOR de estas fuentes, no su dueño: el provider vive acá, en el
// proceso del agente, que corre en el host donde está el dispositivo y
// sobrevive al cierre de la UI (ADR-0006, Detached Runtime).
//
// Lo que este archivo NO hace, a propósito: no abre un stream continuo, no
// guarda video, no persiste frames. Un snapshot es efímero: se captura, se
// entrega y el archivo temporal se borra.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// --- modelo ---

// VisualSourceType enumera las clases de fuente. Sólo "uvc" está implementada
// end-to-end; el resto existe para que agregar una no cambie el contrato.
const (
	SourceTypeUVC     = "uvc"
	SourceTypeDesktop = "desktop"
	SourceTypeWindow  = "window"
	SourceTypeRemote  = "remote"
	SourceTypeVirtual = "virtual"
)

// Modos de observación por IA. Ver el bloque humano y dejar que la IA observe
// son dos permisos distintos: esto es lo segundo, y su default es explícito.
const (
	AIVisionOff      = "off"
	AIVisionOnDemand = "on_demand"
	AIVisionChanges  = "changes"
	// AIVisionContinuous existe para no cerrar la puerta, pero NO es un default
	// válido ni se acepta desde configuración: hay que habilitarlo a mano.
	AIVisionContinuous = "continuous"
)

// Estados de una fuente. `available` significa que el dispositivo aparece en la
// enumeración del host, no que haya alguien mirándolo.
const (
	StatusAvailable = "available"
	StatusOffline   = "offline"
	StatusBusy      = "busy"
	StatusError     = "error"
)

// Taxonomía de errores (§17). El bloque los muestra sin caerse y el cerebro los
// distingue: NO_DEVICE es "todavía no está", DEVICE_REMOVED es "estaba y se fue".
const (
	ErrNoDevice          = "NO_DEVICE"
	ErrDeviceBusy        = "DEVICE_BUSY"
	ErrPermissionDenied  = "PERMISSION_DENIED"
	ErrStreamFailed      = "STREAM_FAILED"
	ErrDeviceRemoved     = "DEVICE_REMOVED"
	ErrUnsupportedFormat = "UNSUPPORTED_FORMAT"
	ErrReconnecting      = "RECONNECTING"
)

// VisualError lleva el código de la taxonomía además del mensaje, para que el
// consumidor decida (reintentar, ofrecer "Select Source", o sólo informar).
type VisualError struct {
	Code   string
	Detail string
}

func (e *VisualError) Error() string {
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

func visualErr(code, detail string) *VisualError { return &VisualError{Code: code, Detail: detail} }

// DeviceSelector identifica un dispositivo físico. Se guarda más de una clave a
// propósito: Windows reescribe el nombre amigable y reordena los índices, pero
// el par vid/pid sobrevive a un reenchufe y a un cambio de puerto.
type DeviceSelector struct {
	// HardwareId: ruta PnP completa (la "Alternative name" de dshow). Es la más
	// específica y la primera que se intenta.
	HardwareId string `json:"hardwareid,omitempty"`
	// Name: nombre amigable ("USB Video"). Genérico en las capturadoras baratas,
	// por eso nunca decide solo si hay vid/pid disponibles.
	Name string `json:"name,omitempty"`
	Vid  string `json:"vid,omitempty"`
	Pid  string `json:"pid,omitempty"`
	// Path: nodo de dispositivo en Linux (/dev/videoN).
	Path string `json:"path,omitempty"`
}

func (d DeviceSelector) empty() bool {
	return d.HardwareId == "" && d.Name == "" && d.Vid == "" && d.Path == ""
}

// AudioSelector: la capturadora expone su audio HDMI como un dispositivo aparte.
// Se detecta y se reporta; reproducirlo no es parte de este vertical slice.
type AudioSelector struct {
	Name       string `json:"name,omitempty"`
	HardwareId string `json:"hardwareid,omitempty"`
	Enabled    bool   `json:"enabled,omitempty"`
}

// VisualSource es la unidad de configuración. `Label` es sólo una etiqueta:
// nada en la arquitectura sabe qué es un "banco".
type VisualSource struct {
	Id       string         `json:"id"`
	Type     string         `json:"type"`
	Label    string         `json:"label"`
	Device   DeviceSelector `json:"device"`
	Audio    *AudioSelector `json:"audio,omitempty"`
	AIVision string         `json:"aivision,omitempty"`
	// Width/Height/FPS son preferencias de captura, no promesas: el dispositivo
	// recorta a lo que soporta.
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	FPS    int `json:"fps,omitempty"`
}

// aiVisionMode normaliza el modo, rechazando `continuous` desde config: quien
// lo quiera tiene que habilitarlo deliberadamente en código, no por descuido.
func (s *VisualSource) aiVisionMode() string {
	switch strings.ToLower(strings.TrimSpace(s.AIVision)) {
	case AIVisionOff:
		return AIVisionOff
	case AIVisionChanges:
		return AIVisionChanges
	case AIVisionOnDemand:
		return AIVisionOnDemand
	default:
		return AIVisionOnDemand
	}
}

// DiscoveredDevice es lo que el host reporta hoy, sin relación con la config.
type DiscoveredDevice struct {
	Name       string `json:"name"`
	HardwareId string `json:"hardwareid,omitempty"`
	Vid        string `json:"vid,omitempty"`
	Pid        string `json:"pid,omitempty"`
	Path       string `json:"path,omitempty"`
	Kind       string `json:"kind"` // video | audio
}

// ResolvedSource = configuración + realidad del host en este instante.
type ResolvedSource struct {
	Source     VisualSource      `json:"-"`
	Id         string            `json:"id"`
	Type       string            `json:"type"`
	Label      string            `json:"label"`
	Status     string            `json:"status"`
	Available  bool              `json:"available"`
	Connected  bool              `json:"connected"`
	AIVision   string            `json:"ai_vision"`
	Device     *DiscoveredDevice `json:"device,omitempty"`
	MatchedBy  string            `json:"matched_by,omitempty"`
	Error      string            `json:"error,omitempty"`
	AudioFound bool              `json:"audio_available"`
	Width      int               `json:"width,omitempty"`
	Height     int               `json:"height,omitempty"`
	FPS        int               `json:"fps,omitempty"`
}

// --- configuración ---

// VisualSourceCatalog se guarda dentro de settings.json del Workbench, bajo la
// clave `nexus:visualsources`. Es el mismo mecanismo que ya usa
// `nexus:environments`: se edita desde la UI de Settings, sobrevive a
// reinstalaciones y no agrega un sistema de configuración nuevo.
const VisualSourcesSettingsKey = "nexus:visualsources"

// ResolveConfigDir replica la convención de directorios del motor (envPaths).
// El agente corre fuera de Electron, así que no hereda WAVETERM_CONFIG_HOME.
func ResolveConfigDir(explicit string, dev bool) string {
	if explicit != "" {
		return explicit
	}
	if v := os.Getenv("WAVETERM_CONFIG_HOME"); v != "" {
		return v
	}
	name := "waveterm"
	if dev {
		name = "waveterm-dev"
	}
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return filepath.Join(v, name)
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", name)
}

// ResolveSettingsPath ubica el settings.json del motor.
func ResolveSettingsPath(explicitConfigDir string, dev bool) string {
	return filepath.Join(ResolveConfigDir(explicitConfigDir, dev), "settings.json")
}

// LoadVisualSources lee las fuentes de un settings.json. Un archivo ausente o
// sin la clave no es un error: significa "todavía no hay fuentes configuradas".
func LoadVisualSources(settingsPath string) ([]VisualSource, error) {
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("leyendo %s: %w", settingsPath, err)
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, fmt.Errorf("parseando %s: %w", settingsPath, err)
	}
	blob, ok := settings[VisualSourcesSettingsKey]
	if !ok || len(blob) == 0 {
		return nil, nil
	}
	var sources []VisualSource
	if err := json.Unmarshal(blob, &sources); err != nil {
		return nil, fmt.Errorf("parseando %s en %s: %w", VisualSourcesSettingsKey, settingsPath, err)
	}
	out := make([]VisualSource, 0, len(sources))
	for _, s := range sources {
		if strings.TrimSpace(s.Id) == "" {
			continue // una fuente sin id no es direccionable: se ignora, no rompe
		}
		if s.Type == "" {
			s.Type = SourceTypeUVC
		}
		if s.Label == "" {
			s.Label = s.Id
		}
		out = append(out, s)
	}
	return out, nil
}

// --- enumeración de dispositivos ---

// DeviceEnumerator aísla la dependencia del sistema operativo para que la
// selección de fuente sea testeable sin hardware.
type DeviceEnumerator interface {
	Enumerate(ctx context.Context) ([]DiscoveredDevice, error)
}

// ffmpegRunner permite inyectar la ejecución en tests.
type ffmpegRunner func(ctx context.Context, args ...string) (stdout []byte, stderr []byte, err error)

// FFmpegEnumerator enumera con ffmpeg: dshow en Windows, v4l2 en Linux. Se usa
// ffmpeg y no una API nativa porque ya es la dependencia que captura el frame:
// si falta, falla el snapshot igual, y una sola dependencia es más honesta que
// dos caminos que pueden discrepar.
type FFmpegEnumerator struct {
	Bin      string
	Run      ffmpegRunner
	GOOS     string
	cache    []DiscoveredDevice
	cachedAt time.Time
	mu       sync.Mutex
	// TTL corto: enumerar cuesta ~200ms y el usuario enchufa cosas mientras usa
	// la app. Sin cache, cada `visual.sources.list` paga el costo completo.
	TTL time.Duration
}

func NewFFmpegEnumerator(bin string) *FFmpegEnumerator {
	if bin == "" {
		bin = "ffmpeg"
	}
	return &FFmpegEnumerator{Bin: bin, GOOS: runtime.GOOS, TTL: 3 * time.Second}
}

func (e *FFmpegEnumerator) run(ctx context.Context, args ...string) ([]byte, []byte, error) {
	if e.Run != nil {
		return e.Run(ctx, args...)
	}
	cmd := exec.CommandContext(ctx, e.Bin, args...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	return out.Bytes(), errb.Bytes(), err
}

func (e *FFmpegEnumerator) Enumerate(ctx context.Context) ([]DiscoveredDevice, error) {
	e.mu.Lock()
	if e.TTL > 0 && e.cache != nil && time.Since(e.cachedAt) < e.TTL {
		cached := append([]DiscoveredDevice(nil), e.cache...)
		e.mu.Unlock()
		return cached, nil
	}
	e.mu.Unlock()

	goos := e.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	var devices []DiscoveredDevice
	var err error
	if goos == "windows" {
		devices, err = e.enumerateDshow(ctx)
	} else {
		devices, err = e.enumerateV4L2(ctx)
	}
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	e.cache = append([]DiscoveredDevice(nil), devices...)
	e.cachedAt = time.Now()
	e.mu.Unlock()
	return devices, nil
}

// `-list_devices true` siempre termina con error ("Error opening input file
// dummy"): la lista se imprime por stderr. Por eso se ignora el exit code y se
// falla sólo si no se pudo parsear nada.
func (e *FFmpegEnumerator) enumerateDshow(ctx context.Context) ([]DiscoveredDevice, error) {
	_, stderr, _ := e.run(ctx, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy")
	devices := parseDshowDevices(string(stderr))
	if len(devices) == 0 && len(stderr) == 0 {
		return nil, visualErr(ErrStreamFailed, "ffmpeg no devolvió nada al enumerar dshow")
	}
	return devices, nil
}

var (
	dshowDeviceRe = regexp.MustCompile(`^\[dshow @ [0-9a-fx]+\]\s+"(.+)"\s+\((video|audio|none)\)\s*$`)
	dshowAltRe    = regexp.MustCompile(`^\[dshow @ [0-9a-fx]+\]\s+Alternative name\s+"(.+)"\s*$`)
	vidPidRe      = regexp.MustCompile(`(?i)vid_([0-9a-f]{4})&pid_([0-9a-f]{4})`)
)

// parseDshowDevices es puro para poder fijarlo con la salida real de ffmpeg 8.x.
// Los dispositivos "(none)" (una cámara virtual apagada, típicamente OBS) se
// descartan: aparecen en la lista pero no entregan un frame.
func parseDshowDevices(stderr string) []DiscoveredDevice {
	var devices []DiscoveredDevice
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimRight(line, "\r")
		if m := dshowDeviceRe.FindStringSubmatch(line); m != nil {
			kind := m[2]
			if kind == "none" {
				devices = append(devices, DiscoveredDevice{Name: m[1], Kind: "none"})
				continue
			}
			devices = append(devices, DiscoveredDevice{Name: m[1], Kind: kind})
			continue
		}
		if m := dshowAltRe.FindStringSubmatch(line); m != nil && len(devices) > 0 {
			last := &devices[len(devices)-1]
			last.HardwareId = m[1]
			if vp := vidPidRe.FindStringSubmatch(m[1]); vp != nil {
				last.Vid = strings.ToLower(vp[1])
				last.Pid = strings.ToLower(vp[2])
			}
		}
	}
	out := devices[:0]
	for _, d := range devices {
		if d.Kind == "none" {
			continue
		}
		out = append(out, d)
	}
	return out
}

// En Linux no hay dshow: se listan los nodos v4l2 y se lee el nombre del driver
// desde sysfs. Alcanza para desarrollo y CI; el hardware real es Windows.
func (e *FFmpegEnumerator) enumerateV4L2(ctx context.Context) ([]DiscoveredDevice, error) {
	matches, err := filepath.Glob("/dev/video*")
	if err != nil || len(matches) == 0 {
		return nil, nil
	}
	sort.Strings(matches)
	devices := make([]DiscoveredDevice, 0, len(matches))
	for _, path := range matches {
		name := filepath.Base(path)
		if raw, err := os.ReadFile(filepath.Join("/sys/class/video4linux", name, "name")); err == nil {
			name = strings.TrimSpace(string(raw))
		}
		devices = append(devices, DiscoveredDevice{Name: name, Path: path, Kind: "video"})
	}
	return devices, nil
}

// --- resolución fuente -> dispositivo ---

// matchDevice elige el dispositivo para una fuente configurada. El orden es de
// más específico a menos, y NUNCA hay un "el primero que haya": si la
// capturadora configurada no está, la webcam personal no la reemplaza.
func matchDevice(sel DeviceSelector, devices []DiscoveredDevice) (*DiscoveredDevice, string) {
	video := make([]DiscoveredDevice, 0, len(devices))
	for _, d := range devices {
		if d.Kind == "video" {
			video = append(video, d)
		}
	}
	norm := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

	if sel.HardwareId != "" {
		for i := range video {
			if norm(video[i].HardwareId) == norm(sel.HardwareId) {
				return &video[i], "hardwareid"
			}
		}
	}
	if sel.Path != "" {
		for i := range video {
			if video[i].Path == sel.Path {
				return &video[i], "path"
			}
		}
	}
	// vid/pid sobrevive al reenchufe y al cambio de puerto: es el fallback bueno
	// cuando Windows reescribe la ruta PnP.
	if sel.Vid != "" && sel.Pid != "" {
		for i := range video {
			if norm(video[i].Vid) == norm(sel.Vid) && norm(video[i].Pid) == norm(sel.Pid) {
				return &video[i], "vidpid"
			}
		}
	}
	// El nombre es lo último y sólo si es inequívoco: "USB Video" es el nombre de
	// media docena de capturadoras distintas, y elegir la equivocada es peor que
	// no elegir.
	if sel.Name != "" {
		var hit *DiscoveredDevice
		count := 0
		for i := range video {
			if norm(video[i].Name) == norm(sel.Name) {
				hit = &video[i]
				count++
			}
		}
		if count == 1 {
			return hit, "name"
		}
		if count > 1 {
			return nil, "ambiguous_name"
		}
	}
	return nil, ""
}

// matchAudio busca el audio que acompaña a la capturadora. Sólo detección: que
// exista no significa que se reproduzca.
func matchAudio(a *AudioSelector, dev *DiscoveredDevice, devices []DiscoveredDevice) bool {
	if a == nil && dev == nil {
		return false
	}
	norm := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	for _, d := range devices {
		if d.Kind != "audio" {
			continue
		}
		if a != nil && a.Name != "" && norm(d.Name) == norm(a.Name) {
			return true
		}
		// mismo vid/pid = misma capturadora: su audio HDMI viaja en otra interfaz
		if dev != nil && dev.Vid != "" && d.Vid != "" && d.Vid == dev.Vid && d.Pid == dev.Pid {
			return true
		}
	}
	return false
}

// --- registry ---

// VisualSourceRegistry es el provider: mantiene la configuración, la contrasta
// con el host y entrega frames. No guarda estado de UI ni sabe que existe un
// bloque; el Workbench es un consumidor más.
type VisualSourceRegistry struct {
	mu           sync.RWMutex
	sources      []VisualSource
	enumerator   DeviceEnumerator
	settingsPath string
	ffmpegBin    string
	// lastSeen recuerda qué fuentes llegaron a estar presentes, para distinguir
	// "nunca estuvo" (NO_DEVICE) de "estaba y se fue" (DEVICE_REMOVED).
	lastSeen map[string]bool
	// viewerHeld: ids que un viewer humano tiene abiertos. Una capturadora UVC
	// no admite dos consumidores; con el viewer abierto, capturar por ffmpeg
	// devolvería DEVICE_BUSY o le robaría la imagen al usuario.
	viewerHeld map[string]bool
	snapshotFn func(ctx context.Context, r *VisualSourceRegistry, res *ResolvedSource) ([]byte, error)
}

func NewVisualSourceRegistry(settingsPath, ffmpegBin string) *VisualSourceRegistry {
	return &VisualSourceRegistry{
		enumerator:   NewFFmpegEnumerator(ffmpegBin),
		settingsPath: settingsPath,
		ffmpegBin:    ffmpegBin,
		lastSeen:     map[string]bool{},
		viewerHeld:   map[string]bool{},
	}
}

func (r *VisualSourceRegistry) SetEnumerator(e DeviceEnumerator) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.enumerator = e
}

// Reload relee la configuración. Se llama en cada listado: editar la fuente en
// Settings tiene que verse sin reiniciar el agente.
func (r *VisualSourceRegistry) Reload() error {
	if r.settingsPath == "" {
		return nil
	}
	sources, err := LoadVisualSources(r.settingsPath)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.sources = sources
	r.mu.Unlock()
	return nil
}

// SetViewerAttached lo llama el bloque al tomar/soltar el dispositivo.
func (r *VisualSourceRegistry) SetViewerAttached(sourceId string, attached bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if attached {
		r.viewerHeld[sourceId] = true
		return
	}
	delete(r.viewerHeld, sourceId)
}

func (r *VisualSourceRegistry) ViewerAttached(sourceId string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.viewerHeld[sourceId]
}

// List contrasta configuración contra host. Nunca devuelve error por un
// dispositivo ausente: una fuente offline es un estado legítimo, no una falla.
func (r *VisualSourceRegistry) List(ctx context.Context) ([]ResolvedSource, error) {
	if err := r.Reload(); err != nil {
		return nil, err
	}
	r.mu.RLock()
	sources := append([]VisualSource(nil), r.sources...)
	enum := r.enumerator
	r.mu.RUnlock()

	var devices []DiscoveredDevice
	var enumErr error
	if enum != nil {
		devices, enumErr = enum.Enumerate(ctx)
	}

	out := make([]ResolvedSource, 0, len(sources))
	for _, s := range sources {
		res := ResolvedSource{
			Source: s, Id: s.Id, Type: s.Type, Label: s.Label,
			AIVision: s.aiVisionMode(),
			Width:    s.Width, Height: s.Height, FPS: s.FPS,
		}
		if enumErr != nil {
			res.Status = StatusError
			res.Error = enumErr.Error()
			out = append(out, res)
			continue
		}
		if s.Type != SourceTypeUVC {
			// Otros tipos declaran su contrato pero todavía no tienen provider.
			res.Status = StatusOffline
			res.Error = ErrNoDevice + ": tipo " + s.Type + " sin provider implementado"
			out = append(out, res)
			continue
		}
		dev, how := matchDevice(s.Device, devices)
		if dev == nil {
			res.Status = StatusOffline
			r.mu.Lock()
			seen := r.lastSeen[s.Id]
			r.mu.Unlock()
			if how == "ambiguous_name" {
				res.Error = ErrNoDevice + ": hay más de un dispositivo llamado " + s.Device.Name + "; configurar vid/pid"
			} else if seen {
				res.Error = ErrDeviceRemoved
			} else {
				res.Error = ErrNoDevice
			}
			out = append(out, res)
			continue
		}
		r.mu.Lock()
		r.lastSeen[s.Id] = true
		held := r.viewerHeld[s.Id]
		r.mu.Unlock()
		res.Device = dev
		res.MatchedBy = how
		res.Available = true
		res.Connected = true
		res.Status = StatusAvailable
		if held {
			// Disponible y tomada por el viewer: no es un error, es información
			// que el consumidor necesita para decidir por dónde pedir el frame.
			res.Status = StatusBusy
		}
		res.AudioFound = matchAudio(s.Audio, dev, devices)
		out = append(out, res)
	}
	return out, nil
}

// Get resuelve una fuente por id.
func (r *VisualSourceRegistry) Get(ctx context.Context, id string) (*ResolvedSource, error) {
	list, err := r.List(ctx)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].Id == id {
			return &list[i], nil
		}
	}
	return nil, visualErr(ErrNoDevice, "no hay una fuente visual con id "+id)
}

// --- captura ---

// SnapshotMaxWait acota la captura: un dispositivo colgado no puede bloquear al
// cerebro esperando un frame que no va a llegar.
const SnapshotMaxWait = 12 * time.Second

// warmupFrames: las capturadoras MS2109 y las webcams con auto-exposición lenta
// entregan los primeros cuadros en negro o verde. Con `-update 1` el archivo
// termina conteniendo el último, así que pedir varios es el warmup.
const warmupFrames = 10

// Snapshot devuelve un frame JPEG de la fuente. Efímero por diseño: el archivo
// temporal se borra siempre, y los bytes no se persisten en ningún lado.
func (r *VisualSourceRegistry) Snapshot(ctx context.Context, id string) ([]byte, *ResolvedSource, error) {
	res, err := r.Get(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if !res.Available {
		code := ErrNoDevice
		if strings.HasPrefix(res.Error, ErrDeviceRemoved) {
			code = ErrDeviceRemoved
		}
		return nil, res, visualErr(code, "la fuente "+id+" no está disponible")
	}
	if r.ViewerAttached(id) {
		// El viewer humano tiene el dispositivo. Capturar por ffmpeg acá sería
		// pelearle el device y devolver DEVICE_BUSY: el frame lo tiene que dar
		// quien ya lo tiene abierto.
		return nil, res, visualErr(ErrDeviceBusy,
			"la fuente "+id+" está tomada por un viewer; el frame debe pedirse al viewer adjunto")
	}
	if r.snapshotFn != nil {
		data, err := r.snapshotFn(ctx, r, res)
		return data, res, err
	}
	data, err := r.captureFFmpeg(ctx, res)
	return data, res, err
}

func (r *VisualSourceRegistry) captureFFmpeg(ctx context.Context, res *ResolvedSource) ([]byte, error) {
	if res.Device == nil {
		return nil, visualErr(ErrNoDevice, "fuente sin dispositivo resuelto")
	}
	ctx, cancel := context.WithTimeout(ctx, SnapshotMaxWait)
	defer cancel()

	tmp, err := os.CreateTemp("", "nexus-visual-*.jpg")
	if err != nil {
		return nil, visualErr(ErrStreamFailed, err.Error())
	}
	tmpPath := tmp.Name()
	tmp.Close()
	// El frame es efímero: pase lo que pase, el temporal no sobrevive a la
	// función. Nada de video en disco (§11).
	defer os.Remove(tmpPath)

	args := snapshotArgs(runtime.GOOS, res, tmpPath)
	bin := r.ffmpegBin
	if bin == "" {
		bin = "ffmpeg"
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	runErr := cmd.Run()

	data, readErr := os.ReadFile(tmpPath)
	if runErr != nil && len(data) == 0 {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, visualErr(ErrStreamFailed, "timeout capturando de "+res.Id)
		}
		return nil, classifyFFmpegError(errb.String(), runErr)
	}
	if readErr != nil || len(data) == 0 {
		return nil, visualErr(ErrStreamFailed, "el dispositivo no entregó ningún frame")
	}
	return data, nil
}

// snapshotArgs es puro para poder fijar la línea de comando en tests.
func snapshotArgs(goos string, res *ResolvedSource, outPath string) []string {
	args := []string{"-hide_banner", "-loglevel", "error"}
	width, height := res.Width, res.Height
	if width <= 0 || height <= 0 {
		// dshow arranca en 640x480 si no se le pide otra cosa: ilegible para leer
		// texto de una pantalla capturada por HDMI.
		width, height = 1920, 1080
	}
	if goos == "windows" {
		args = append(args, "-f", "dshow", "-video_size", fmt.Sprintf("%dx%d", width, height))
		// La ruta PnP es única; el nombre amigable puede estar repetido.
		target := res.Device.Name
		if res.Device.HardwareId != "" {
			target = res.Device.HardwareId
		}
		args = append(args, "-i", "video="+target)
	} else {
		path := res.Device.Path
		if path == "" {
			path = "/dev/video0"
		}
		args = append(args, "-f", "v4l2", "-video_size", fmt.Sprintf("%dx%d", width, height), "-i", path)
	}
	args = append(args,
		"-frames:v", fmt.Sprint(warmupFrames),
		"-update", "1",
		"-q:v", "3",
		"-y", outPath)
	return args
}

// classifyFFmpegError traduce el stderr de ffmpeg a la taxonomía. Se hace por
// texto porque ffmpeg no distingue estos casos por exit code.
func classifyFFmpegError(stderr string, runErr error) error {
	low := strings.ToLower(stderr)
	switch {
	case strings.Contains(low, "could not find video device") ||
		strings.Contains(low, "no such file or directory") ||
		strings.Contains(low, "cannot open video device"):
		return visualErr(ErrDeviceRemoved, firstLine(stderr))
	case strings.Contains(low, "device or resource busy") ||
		strings.Contains(low, "i/o error") ||
		strings.Contains(low, "real-time buffer") ||
		strings.Contains(low, "could not run filter"):
		return visualErr(ErrDeviceBusy, firstLine(stderr))
	case strings.Contains(low, "permission denied") || strings.Contains(low, "access is denied"):
		return visualErr(ErrPermissionDenied, firstLine(stderr))
	case strings.Contains(low, "unsupported") || strings.Contains(low, "could not set video options") ||
		strings.Contains(low, "no pixel format"):
		return visualErr(ErrUnsupportedFormat, firstLine(stderr))
	case strings.Contains(low, "executable file not found") ||
		(runErr != nil && strings.Contains(strings.ToLower(runErr.Error()), "executable file not found")):
		return visualErr(ErrStreamFailed, "no se encontró ffmpeg en el host")
	}
	detail := firstLine(stderr)
	if detail == "" && runErr != nil {
		detail = runErr.Error()
	}
	return visualErr(ErrStreamFailed, detail)
}

// FrameMeta describe un frame sin llevarlo consigo: es lo que puede viajar al
// contexto, a la auditoría y a los logs. Los bytes viajan sólo por la capability
// que los pidió explícitamente.
type FrameMeta struct {
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Bytes       int    `json:"bytes"`
	Format      string `json:"format"`
	ContentHash string `json:"content_hash"`
	CapturedAt  int64  `json:"captured_at"`
}

// DescribeFrame lee las dimensiones del encabezado JPEG. Si el frame viniera
// corrupto, devuelve lo que sí sabe en vez de fallar: el consumidor ya tiene el
// error del provider si hubo uno.
func DescribeFrame(data []byte) FrameMeta {
	sum := sha256.Sum256(data)
	meta := FrameMeta{
		Bytes:       len(data),
		Format:      "jpeg",
		ContentHash: hex.EncodeToString(sum[:16]),
		CapturedAt:  time.Now().UnixMilli(),
	}
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(data)); err == nil {
		meta.Width = cfg.Width
		meta.Height = cfg.Height
	}
	return meta
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// AsVisualError expone errors.As sin obligar a cada consumidor a importar
// errors sólo para leer el código de la taxonomía.
func AsVisualError(err error, target **VisualError) bool {
	return errors.As(err, target)
}
