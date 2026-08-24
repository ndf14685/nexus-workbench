// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Salida textual de `ffmpeg -list_devices true -f dshow -i dummy` (ffmpeg 8.0.1)
// tomada del host real, con la capturadora MS2109 y la webcam personal
// conectadas al mismo tiempo. Incluye el ruido del driver de NVIDIA en el medio,
// que es exactamente lo que rompe un parser ingenuo.
const realDshowOutput = `[dshow @ 000001bda4345040] "USB Video" (video)
[dshow @ 000001bda4345040]   Alternative name "@device_pnp_\\?\usb#vid_534d&pid_2109&mi_00#7&39c1908f&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
[dshow @ 000001bda4345040] "HD Pro Webcam C920" (video)
[dshow @ 000001bda4345040]   Alternative name "@device_pnp_\\?\usb#vid_046d&pid_082d&mi_00#7&37f5ebfe&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global"
I2026-08-24 13:50:35.707108 (22292) [INFO] [VCAMDS] ffmpeg.exe
E2026-08-24 13:50:35.707108 (22292)  [ERR] [VCAMDS] Failed to open NBX hive
[dshow @ 000001bda4345040] "Camera (NVIDIA Broadcast)" (video)
[dshow @ 000001bda4345040]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\{7BBFF097-B3FB-4B26-B685-7A998DE7CEAC}"
[dshow @ 000001bda4345040] "OBS Virtual Camera" (none)
[dshow @ 000001bda4345040]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 000001bda4345040] "Digital Audio Interface (USB Digital Audio)" (audio)
[dshow @ 000001bda4345040]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{1A430BF9-F0BF-42F8-8831-BFAD70E76B23}"
[dshow @ 000001bda4345040] "Microphone (NVIDIA Broadcast)" (audio)
[dshow @ 000001bda4345040]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{8F8F2EDE-D38B-4AA6-A4FA-177B966AC455}"
Error opening input file dummy.
`

func TestParseDshowDevicesRealOutput(t *testing.T) {
	devices := parseDshowDevices(realDshowOutput)

	var names []string
	for _, d := range devices {
		names = append(names, d.Name+"/"+d.Kind)
	}
	// La camara virtual "(none)" queda afuera: aparece listada pero no entrega frame.
	for _, n := range names {
		if strings.HasPrefix(n, "OBS Virtual Camera") {
			t.Fatalf("un dispositivo (none) no deberia listarse: %v", names)
		}
	}
	if len(devices) != 5 {
		t.Fatalf("esperaba 5 dispositivos utilizables, hubo %d: %v", len(devices), names)
	}

	capture := devices[0]
	if capture.Name != "USB Video" || capture.Kind != "video" {
		t.Fatalf("primer dispositivo inesperado: %+v", capture)
	}
	if capture.Vid != "534d" || capture.Pid != "2109" {
		t.Fatalf("vid/pid mal extraidos de la ruta PnP: %+v", capture)
	}
	if !strings.Contains(capture.HardwareId, "usb#vid_534d") {
		t.Fatalf("hardwareid no capturado: %+v", capture)
	}
	if devices[1].Vid != "046d" || devices[1].Pid != "082d" {
		t.Fatalf("la webcam quedo mal parseada: %+v", devices[1])
	}

	// Realidad del host, verificada contra ffmpeg 8.0.1: los dispositivos de
	// AUDIO se listan con la forma waveout (@device_cm_...wave_{GUID}), que NO
	// lleva vid/pid, aunque el mismo dispositivo si lo exponga por PnP. Por eso
	// el audio de una capturadora no se puede correlacionar por vid/pid en
	// Windows: hay que nombrarlo.
	var audio *DiscoveredDevice
	for i := range devices {
		if devices[i].Kind == "audio" && strings.Contains(devices[i].Name, "USB Digital Audio") {
			audio = &devices[i]
		}
	}
	if audio == nil {
		t.Fatal("no se listo el audio de la capturadora")
	}
	if audio.Vid != "" {
		t.Fatalf("el audio dshow no expone vid/pid en este host: %+v", audio)
	}
}
func TestParseDshowDevicesEmpty(t *testing.T) {
	if got := parseDshowDevices(""); len(got) != 0 {
		t.Fatalf("sin salida no debería haber dispositivos, hubo %v", got)
	}
}

var hostDevices = parseDshowDevices(realDshowOutput)

func TestMatchDevicePrefersHardwareId(t *testing.T) {
	sel := DeviceSelector{
		HardwareId: `@device_pnp_\\?\usb#vid_534d&pid_2109&mi_00#7&39c1908f&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global`,
		Name:       "HD Pro Webcam C920", // nombre contradictorio a propósito
	}
	dev, how := matchDevice(sel, hostDevices)
	if dev == nil || dev.Name != "USB Video" || how != "hardwareid" {
		t.Fatalf("la ruta PnP tiene que ganarle al nombre: %+v (%s)", dev, how)
	}
}

func TestMatchDeviceFallsBackToVidPidWhenWindowsRewritesThePath(t *testing.T) {
	// Caso real: se reenchufa la capturadora en otro puerto USB y la ruta PnP
	// cambia. vid/pid no cambia.
	sel := DeviceSelector{
		HardwareId: `@device_pnp_\\?\usb#vid_534d&pid_2109&mi_00#OTRO&PUERTO#{65e8773d}\global`,
		Vid:        "534d", Pid: "2109",
	}
	dev, how := matchDevice(sel, hostDevices)
	if dev == nil || dev.Name != "USB Video" || how != "vidpid" {
		t.Fatalf("esperaba match por vid/pid, hubo %+v (%s)", dev, how)
	}
}

func TestMatchDeviceNeverFallsBackToThePersonalWebcam(t *testing.T) {
	// La capturadora no está conectada. Hay UNA sola cámara presente: la webcam
	// personal. No se la elige.
	onlyWebcam := []DiscoveredDevice{
		{Name: "HD Pro Webcam C920", Kind: "video", Vid: "046d", Pid: "082d"},
	}
	sel := DeviceSelector{Name: "USB Video", Vid: "534d", Pid: "2109"}
	dev, how := matchDevice(sel, onlyWebcam)
	if dev != nil {
		t.Fatalf("no se puede caer en la webcam personal: eligió %+v (%s)", dev, how)
	}
}

func TestMatchDeviceRefusesAmbiguousName(t *testing.T) {
	// Dos capturadoras baratas del mismo modelo: mismo nombre amigable, distinto
	// hardware. Elegir cualquiera es peor que no elegir.
	twoCards := []DiscoveredDevice{
		{Name: "USB Video", Kind: "video", Vid: "534d", Pid: "2109", HardwareId: "a"},
		{Name: "USB Video", Kind: "video", Vid: "1de1", Pid: "f105", HardwareId: "b"},
	}
	dev, how := matchDevice(DeviceSelector{Name: "USB Video"}, twoCards)
	if dev != nil || how != "ambiguous_name" {
		t.Fatalf("un nombre ambiguo no puede resolver: %+v (%s)", dev, how)
	}
}

func TestMatchDeviceIgnoresAudioDevices(t *testing.T) {
	sel := DeviceSelector{Name: "Digital Audio Interface (USB Digital Audio)"}
	if dev, _ := matchDevice(sel, hostDevices); dev != nil {
		t.Fatalf("una fuente de video no puede resolver a un dispositivo de audio: %+v", dev)
	}
}

func TestMatchAudioNeedsAnExplicitNameOnWindows(t *testing.T) {
	video, _ := matchDevice(DeviceSelector{Vid: "534d", Pid: "2109"}, hostDevices)
	if video == nil {
		t.Fatal("no se resolvio el video de la capturadora")
	}
	// Sin configurar el nombre no hay correlacion posible: el audio de dshow no
	// trae vid/pid. Reportar "hay audio" seria inventar.
	if matchAudio(nil, video, hostDevices) {
		t.Fatal("sin nombre configurado no se puede afirmar que el audio existe")
	}
	// Con el nombre configurado si se detecta.
	sel := &AudioSelector{Name: "Digital Audio Interface (USB Digital Audio)"}
	if !matchAudio(sel, video, hostDevices) {
		t.Fatal("con el nombre configurado el audio deberia detectarse")
	}
	// Un nombre que no existe no se resuelve por parecido.
	if matchAudio(&AudioSelector{Name: "Otro Audio"}, video, hostDevices) {
		t.Fatal("un nombre inexistente no puede matchear")
	}
}

// En Linux (v4l2 + ALSA) si puede haber vid/pid en ambos lados; la correlacion
// por vid/pid sigue siendo valida y por eso no se elimino.
func TestMatchAudioCorrelatesByVidPidWhenAvailable(t *testing.T) {
	devices := []DiscoveredDevice{
		{Name: "capturadora", Kind: "video", Vid: "534d", Pid: "2109"},
		{Name: "capturadora audio", Kind: "audio", Vid: "534d", Pid: "2109"},
	}
	video := &devices[0]
	if !matchAudio(nil, video, devices) {
		t.Fatal("con vid/pid en ambos lados la correlacion deberia funcionar")
	}
}
func TestAIVisionModeDefaultsAndRejectsContinuous(t *testing.T) {
	cases := map[string]string{
		"":           AIVisionOnDemand,
		"on_demand":  AIVisionOnDemand,
		"OFF":        AIVisionOff,
		"changes":    AIVisionChanges,
		"continuous": AIVisionOnDemand, // no se acepta desde configuración
		"cualquiera": AIVisionOnDemand,
	}
	for in, want := range cases {
		s := VisualSource{AIVision: in}
		if got := s.aiVisionMode(); got != want {
			t.Fatalf("aiVisionMode(%q) = %q, esperaba %q", in, got, want)
		}
	}
}

func writeSettings(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadVisualSources(t *testing.T) {
	path := writeSettings(t, `{
	  "nexus:brainurl": "http://x",
	  "nexus:visualsources": [
	    {"id": "hdmi-primary", "label": "Banco",
	     "device": {"name": "USB Video", "vid": "534d", "pid": "2109"},
	     "aivision": "on_demand"},
	    {"id": "sin-tipo"},
	    {"label": "sin id, se ignora"}
	  ]
	}`)
	sources, err := LoadVisualSources(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 2 {
		t.Fatalf("una fuente sin id no es direccionable y debe ignorarse: %+v", sources)
	}
	if sources[0].Type != SourceTypeUVC {
		t.Fatalf("el tipo por defecto debería ser uvc: %+v", sources[0])
	}
	if sources[1].Label != "sin-tipo" {
		t.Fatalf("sin label, el id oficia de label: %+v", sources[1])
	}
}

func TestLoadVisualSourcesToleratesMissingFileAndKey(t *testing.T) {
	if got, err := LoadVisualSources(filepath.Join(t.TempDir(), "no-existe.json")); err != nil || got != nil {
		t.Fatalf("un settings.json ausente no es un error: %v %v", got, err)
	}
	path := writeSettings(t, `{"nexus:brainurl": "http://x"}`)
	if got, err := LoadVisualSources(path); err != nil || got != nil {
		t.Fatalf("sin la clave no hay fuentes, tampoco error: %v %v", got, err)
	}
}

func TestLoadVisualSourcesReportsCorruptFile(t *testing.T) {
	path := writeSettings(t, `{"nexus:visualsources": "esto no es una lista"}`)
	if _, err := LoadVisualSources(path); err == nil {
		t.Fatal("una config corrupta tiene que informarse, no ignorarse en silencio")
	}
}

// --- registry ---

type fakeEnumerator struct {
	devices []DiscoveredDevice
	err     error
	calls   int
}

func (f *fakeEnumerator) Enumerate(context.Context) ([]DiscoveredDevice, error) {
	f.calls++
	return f.devices, f.err
}

func testRegistry(t *testing.T, settings string, devices []DiscoveredDevice) (*VisualSourceRegistry, *fakeEnumerator) {
	t.Helper()
	path := writeSettings(t, settings)
	reg := NewVisualSourceRegistry(path, "ffmpeg")
	enum := &fakeEnumerator{devices: devices}
	reg.SetEnumerator(enum)
	return reg, enum
}

const oneSourceSettings = `{"nexus:visualsources": [
  {"id": "hdmi-primary", "label": "Banco",
   "device": {"name": "USB Video", "vid": "534d", "pid": "2109"}}
]}`

func TestRegistryListAvailable(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	list, err := reg.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("esperaba una fuente: %+v", list)
	}
	got := list[0]
	if got.Status != StatusAvailable || !got.Available || got.Error != "" {
		t.Fatalf("la fuente debería estar disponible: %+v", got)
	}
	if got.Label != "Banco" || got.AIVision != AIVisionOnDemand {
		t.Fatalf("label/modo inesperados: %+v", got)
	}
	if got.AudioFound {
		t.Fatalf("sin audio configurado no se puede afirmar que existe: %+v", got)
	}
}

func TestRegistryOfflineThenRemovedTransition(t *testing.T) {
	// Nunca estuvo: NO_DEVICE.
	reg, enum := testRegistry(t, oneSourceSettings, nil)
	list, err := reg.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if list[0].Status != StatusOffline || list[0].Error != ErrNoDevice {
		t.Fatalf("una fuente que nunca apareció es NO_DEVICE: %+v", list[0])
	}

	// Se conecta.
	enum.devices = hostDevices
	if list, _ = reg.List(context.Background()); list[0].Status != StatusAvailable {
		t.Fatalf("al conectarse debería pasar a available: %+v", list[0])
	}

	// Se desconecta en caliente: ya no es NO_DEVICE, es DEVICE_REMOVED.
	enum.devices = nil
	list, _ = reg.List(context.Background())
	if list[0].Status != StatusOffline || list[0].Error != ErrDeviceRemoved {
		t.Fatalf("desconectar en caliente es DEVICE_REMOVED: %+v", list[0])
	}
}

func TestRegistryReportsBusyWhenViewerHoldsTheDevice(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	reg.SetViewerAttached("hdmi-primary", true)
	list, _ := reg.List(context.Background())
	if list[0].Status != StatusBusy || !list[0].Available {
		t.Fatalf("con el viewer adjunto la fuente sigue disponible pero ocupada: %+v", list[0])
	}
	reg.SetViewerAttached("hdmi-primary", false)
	list, _ = reg.List(context.Background())
	if list[0].Status != StatusAvailable {
		t.Fatalf("al soltar el viewer vuelve a available: %+v", list[0])
	}
}

func TestRegistryListSurvivesEnumerationFailure(t *testing.T) {
	reg, enum := testRegistry(t, oneSourceSettings, nil)
	enum.err = errors.New("ffmpeg no está instalado")
	list, err := reg.List(context.Background())
	if err != nil {
		t.Fatalf("un host sin ffmpeg no puede romper el listado: %v", err)
	}
	if list[0].Status != StatusError || list[0].Error == "" {
		t.Fatalf("el fallo tiene que quedar contenido en la fuente: %+v", list[0])
	}
}

func TestRegistryNonUVCTypeDeclaresItselfUnimplemented(t *testing.T) {
	reg, _ := testRegistry(t, `{"nexus:visualsources": [
	  {"id": "pantalla", "type": "desktop", "label": "Monitor 2"}]}`, hostDevices)
	list, _ := reg.List(context.Background())
	if list[0].Status != StatusOffline || !strings.Contains(list[0].Error, "sin provider") {
		t.Fatalf("un tipo sin provider tiene que decirlo, no fingir: %+v", list[0])
	}
}

func TestRegistrySnapshotRefusesWhenViewerHoldsDevice(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	reg.SetViewerAttached("hdmi-primary", true)
	_, _, err := reg.Snapshot(context.Background(), "hdmi-primary")
	var ve *VisualError
	if !errors.As(err, &ve) || ve.Code != ErrDeviceBusy {
		t.Fatalf("con viewer adjunto el snapshot debe delegar, no pelear el device: %v", err)
	}
}

func TestRegistrySnapshotUnknownSource(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	_, _, err := reg.Snapshot(context.Background(), "no-existe")
	var ve *VisualError
	if !errors.As(err, &ve) || ve.Code != ErrNoDevice {
		t.Fatalf("esperaba NO_DEVICE, hubo %v", err)
	}
}

func TestRegistrySnapshotOfflineSource(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, nil)
	_, res, err := reg.Snapshot(context.Background(), "hdmi-primary")
	if err == nil {
		t.Fatal("una fuente offline no puede devolver frame")
	}
	if res == nil || res.Status != StatusOffline {
		t.Fatalf("el estado de la fuente tiene que venir igual: %+v", res)
	}
}

// --- captura ---

func TestSnapshotArgsWindowsUsesPnpPathAndWarmup(t *testing.T) {
	res := &ResolvedSource{
		Id: "hdmi-primary",
		Device: &DiscoveredDevice{
			Name:       "USB Video",
			HardwareId: `@device_pnp_\\?\usb#vid_534d&pid_2109&mi_00#x\global`,
		},
	}
	args := snapshotArgs("windows", res, "C:/tmp/x.jpg")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-f dshow") {
		t.Fatalf("en Windows se captura por dshow: %s", joined)
	}
	if !strings.Contains(joined, "video=@device_pnp_") {
		t.Fatalf("debe usarse la ruta PnP, no el nombre ambiguo: %s", joined)
	}
	if !strings.Contains(joined, "1920x1080") {
		t.Fatalf("sin resolución configurada se pide 1080p, no el default 640x480: %s", joined)
	}
	if !strings.Contains(joined, "-update 1") || !strings.Contains(joined, "-frames:v 10") {
		t.Fatalf("faltan los frames de warmup con -update: %s", joined)
	}
}

func TestSnapshotArgsFallsBackToFriendlyNameWithoutPnpPath(t *testing.T) {
	res := &ResolvedSource{Device: &DiscoveredDevice{Name: "USB Video"}}
	joined := strings.Join(snapshotArgs("windows", res, "x.jpg"), " ")
	if !strings.Contains(joined, "video=USB Video") {
		t.Fatalf("sin ruta PnP se usa el nombre: %s", joined)
	}
}

func TestSnapshotArgsHonorsConfiguredResolution(t *testing.T) {
	res := &ResolvedSource{Width: 1280, Height: 720, Device: &DiscoveredDevice{Name: "USB Video"}}
	joined := strings.Join(snapshotArgs("windows", res, "x.jpg"), " ")
	if !strings.Contains(joined, "1280x720") {
		t.Fatalf("la resolución configurada tiene que respetarse: %s", joined)
	}
}

func TestSnapshotArgsLinuxUsesV4L2(t *testing.T) {
	res := &ResolvedSource{Device: &DiscoveredDevice{Name: "cam", Path: "/dev/video2"}}
	joined := strings.Join(snapshotArgs("linux", res, "/tmp/x.jpg"), " ")
	if !strings.Contains(joined, "-f v4l2") || !strings.Contains(joined, "-i /dev/video2") {
		t.Fatalf("en Linux se captura por v4l2: %s", joined)
	}
}

func TestClassifyFFmpegError(t *testing.T) {
	cases := []struct {
		stderr string
		want   string
	}{
		{`Could not find video device with name ["USB Video"] among source devices`, ErrDeviceRemoved},
		{"real-time buffer [USB Video] too full", ErrDeviceBusy},
		// texto exacto de ffmpeg 8.0.1 en el host real cuando la capturadora ya
		// esta tomada por otro proceso (verificado con dos ffmpeg simultaneos)
		{"[dshow @ 0] Could not run graph (sometimes caused by a device already in use by other application)", ErrDeviceBusy},
		{"/dev/video0: Device or resource busy", ErrDeviceBusy},
		{"Error opening input: Permission denied", ErrPermissionDenied},
		{"Could not set video options", ErrUnsupportedFormat},
		{"algo raro pasó", ErrStreamFailed},
	}
	for _, c := range cases {
		err := classifyFFmpegError(c.stderr, nil)
		var ve *VisualError
		if !errors.As(err, &ve) || ve.Code != c.want {
			t.Fatalf("classifyFFmpegError(%q) = %v, esperaba %s", c.stderr, err, c.want)
		}
	}
}

func TestClassifyFFmpegErrorMissingBinary(t *testing.T) {
	err := classifyFFmpegError("", errors.New(`exec: "ffmpeg": executable file not found in $PATH`))
	var ve *VisualError
	if !errors.As(err, &ve) || ve.Code != ErrStreamFailed || !strings.Contains(ve.Detail, "ffmpeg") {
		t.Fatalf("un host sin ffmpeg tiene que decirlo: %v", err)
	}
}

func TestResolveConfigDirHonorsOverride(t *testing.T) {
	t.Setenv("WAVETERM_CONFIG_HOME", "/tmp/custom-config")
	if got := ResolveConfigDir("", false); got != "/tmp/custom-config" {
		t.Fatalf("la env var del motor manda: %s", got)
	}
	if got := ResolveConfigDir("/explicito", false); got != "/explicito" {
		t.Fatalf("el flag explícito gana sobre todo: %s", got)
	}
}
