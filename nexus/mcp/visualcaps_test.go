// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- utilidades de imagen para no depender de hardware ---

// solidFrame genera un JPEG de un color plano. Dos colores distintos dan hashes
// perceptuales distintos; el mismo color, el mismo hash.
func solidFrame(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 36))
	for y := 0; y < 36; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// halfFrame: mitad izquierda de un color, mitad derecha de otro. Sirve para
// producir un cambio grande y controlado.
func halfFrame(t *testing.T, left, right color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 36))
	for y := 0; y < 36; y++ {
		for x := 0; x < 64; x++ {
			if x < 32 {
				img.Set(x, y, left)
			} else {
				img.Set(x, y, right)
			}
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// --- change detection ---

func TestPerceptualHashIsStableAndDiscriminates(t *testing.T) {
	black := solidFrame(t, color.Black)
	if PerceptualHash(black) != PerceptualHash(black) {
		t.Fatal("el hash del mismo frame tiene que ser estable")
	}
	if len(PerceptualHash(black)) != 16 {
		t.Fatalf("se esperaban 64 bits en hex: %q", PerceptualHash(black))
	}
	split := halfFrame(t, color.Black, color.White)
	if PerceptualHash(black) == PerceptualHash(split) {
		t.Fatal("una pantalla partida en dos no puede hashear igual que una plana")
	}
	if PerceptualHash([]byte("esto no es un jpeg")) != "" {
		t.Fatal("un frame indecodificable no puede producir un hash inventado")
	}
}

func TestHammingFraction(t *testing.T) {
	if got := HammingFraction("ffffffffffffffff", "ffffffffffffffff"); got != 0 {
		t.Fatalf("hashes iguales = 0, hubo %v", got)
	}
	if got := HammingFraction("ffffffffffffffff", "0000000000000000"); got != 1 {
		t.Fatalf("hashes opuestos = 1, hubo %v", got)
	}
	// Lo que no se pudo medir no se puede declarar sin cambios.
	if got := HammingFraction("", "ffffffffffffffff"); got != 1 {
		t.Fatalf("un hash vacio cuenta como todo distinto, hubo %v", got)
	}
}

func TestChangeDetectorSkipsTheBoringFrames(t *testing.T) {
	d := NewChangeDetector(DefaultChangeThreshold, 0)
	black := solidFrame(t, color.Black)

	if dec := d.Evaluate(black, "h1", false); !dec.Analyze || dec.Reason != ChangeFirstFrame {
		t.Fatalf("el primer frame establece la linea de base: %+v", dec)
	}
	// la linea de base no cuenta como observacion: no hubo evento
	if d.Analyzed != 0 {
		t.Fatalf("la linea de base no es una observacion: analyzed=%d", d.Analyzed)
	}
	// Mismo contenido, otro content-hash: el phash no cambia -> no hay evento.
	if dec := d.Evaluate(black, "h2", false); dec.Analyze {
		t.Fatalf("una pantalla identica no puede generar evento: %+v", dec)
	}
	// Mismo content-hash ya visto: dedup.
	if dec := d.Evaluate(black, "h1", false); dec.Analyze || dec.Reason != ChangeDuplicate {
		t.Fatalf("un frame ya visto es duplicado: %+v", dec)
	}
	// Cambio real.
	split := halfFrame(t, color.Black, color.White)
	dec := d.Evaluate(split, "h3", false)
	if !dec.Analyze || dec.Reason != ChangeDetected {
		t.Fatalf("un cambio grande tiene que detectarse: %+v", dec)
	}
	if dec.Distance < DefaultChangeThreshold {
		t.Fatalf("la distancia deberia superar el umbral: %+v", dec)
	}
	if d.ReductionRatio() <= 0 {
		t.Fatal("la reduccion tiene que ser medible: es lo que justifica el detector")
	}
}

func TestChangeDetectorForceIgnoresFilters(t *testing.T) {
	d := NewChangeDetector(DefaultChangeThreshold, time.Hour)
	black := solidFrame(t, color.Black)
	d.Evaluate(black, "h1", false)
	if dec := d.Evaluate(black, "h1", true); !dec.Analyze || dec.Reason != ChangeForced {
		t.Fatalf("un pedido explicito no lo frena ni el dedup ni el cooldown: %+v", dec)
	}
}

func TestChangeDetectorCooldownProtectsTheBrain(t *testing.T) {
	now := time.Unix(1000, 0)
	d := NewChangeDetector(DefaultChangeThreshold, 30*time.Second)
	d.Now = func() time.Time { return now }

	// linea de base: no es un evento, no enfria nada
	d.Evaluate(solidFrame(t, color.Black), "h1", false)
	// primer cambio real: SI es un evento y arranca el cooldown
	if dec := d.Evaluate(halfFrame(t, color.Black, color.White), "h2", false); !dec.Analyze {
		t.Fatalf("el primer cambio real tiene que reportarse enseguida: %+v", dec)
	}
	now = now.Add(time.Second)
	dec := d.Evaluate(solidFrame(t, color.White), "h3", false)
	if dec.Analyze || dec.Reason != ChangeCooldown {
		t.Fatalf("otro cambio dentro del cooldown no se avisa: %+v", dec)
	}
	now = now.Add(time.Minute)
	if dec = d.Evaluate(solidFrame(t, color.White), "h4", false); !dec.Analyze {
		t.Fatalf("pasado el cooldown el cambio si se reporta: %+v", dec)
	}
}
func TestChangeDetectorUndecodableFrame(t *testing.T) {
	d := NewChangeDetector(0, 0)
	if dec := d.Evaluate([]byte("basura"), "h", false); dec.Analyze || dec.Reason != ChangeUndecodable {
		t.Fatalf("un frame roto no dispara analisis: %+v", dec)
	}
}

// --- capabilities ---

type auditEntryRec struct{ tool, detail, decision string }

func testCaps(t *testing.T, settings string, devices []DiscoveredDevice,
	frame func() ([]byte, error)) (*VisualCapabilities, *[]auditEntryRec, *[]map[string]any) {
	t.Helper()
	reg, _ := testRegistry(t, settings, devices)
	if frame != nil {
		reg.snapshotFn = func(context.Context, *VisualSourceRegistry, *ResolvedSource) ([]byte, error) {
			return frame()
		}
	}
	var mu sync.Mutex
	audits := &[]auditEntryRec{}
	events := &[]map[string]any{}
	caps := NewVisualCapabilities(reg,
		func(kind string, payload map[string]any) error {
			mu.Lock()
			defer mu.Unlock()
			p := map[string]any{"kind": kind}
			for k, v := range payload {
				p[k] = v
			}
			*events = append(*events, p)
			return nil
		},
		func(tool, env, detail, decision string) {
			mu.Lock()
			defer mu.Unlock()
			*audits = append(*audits, auditEntryRec{tool, detail, decision})
		})
	return caps, audits, events
}

func TestVisualSourcesListNeverCarriesImageData(t *testing.T) {
	caps, _, _ := testCaps(t, oneSourceSettings, hostDevices, nil)
	out, handled, err := caps.Execute(context.Background(), "visual.sources.list", nil)
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	sources := out["sources"].([]map[string]any)
	if len(sources) != 1 {
		t.Fatalf("esperaba una fuente: %+v", sources)
	}
	s := sources[0]
	if s["label"] != "Banco" || s["status"] != StatusAvailable || s["ai_vision"] != AIVisionOnDemand {
		t.Fatalf("metadata inesperada: %+v", s)
	}
	for _, forbidden := range []string{"image_base64", "image", "frame"} {
		if _, bad := s[forbidden]; bad {
			t.Fatalf("el listado publica metadata, nunca imagen: apareció %q", forbidden)
		}
	}
	// La ruta PnP no le aporta nada al cerebro.
	if dev, _ := s["device"].(string); strings.Contains(dev, "device_pnp") {
		t.Fatalf("no hace falta exponer la ruta PnP: %v", dev)
	}
}

func TestVisualSnapshotReturnsFrameAndAudits(t *testing.T) {
	want := solidFrame(t, color.Black)
	caps, audits, _ := testCaps(t, oneSourceSettings, hostDevices,
		func() ([]byte, error) { return want, nil })

	out, _, err := caps.Execute(context.Background(), "visual.snapshot",
		map[string]any{"source_id": "hdmi-primary"})
	if err != nil {
		t.Fatal(err)
	}
	got, decErr := base64.StdEncoding.DecodeString(out["image_base64"].(string))
	if decErr != nil || !bytes.Equal(got, want) {
		t.Fatal("el frame devuelto no es el capturado")
	}
	meta := out["frame"].(FrameMeta)
	if meta.Width == 0 || meta.ContentHash == "" {
		t.Fatalf("la metadata del frame tiene que venir completa: %+v", meta)
	}
	if len(*audits) != 1 || (*audits)[0].decision != "allowed" ||
		(*audits)[0].tool != "visual.snapshot" {
		t.Fatalf("toda captura se audita: %+v", *audits)
	}
}

func TestVisualSnapshotDeniedWhenAIVisionOff(t *testing.T) {
	// El bloque puede estar abierto y visible: eso NO autoriza a la IA.
	settings := `{"nexus:visualsources": [
	  {"id": "hdmi-primary", "label": "Banco", "aivision": "off",
	   "device": {"vid": "534d", "pid": "2109"}}]}`
	captured := false
	caps, audits, _ := testCaps(t, settings, hostDevices,
		func() ([]byte, error) { captured = true; return solidFrame(t, color.Black), nil })

	_, _, err := caps.Execute(context.Background(), "visual.snapshot",
		map[string]any{"source_id": "hdmi-primary"})
	if err == nil {
		t.Fatal("con ai_vision=off no puede haber frame")
	}
	if captured {
		t.Fatal("ni siquiera se puede abrir el dispositivo si la IA no esta autorizada")
	}
	if len(*audits) != 1 || (*audits)[0].decision != "denied_ai_vision_off" {
		t.Fatalf("la denegacion tiene que quedar auditada: %+v", *audits)
	}
}

func TestVisualObserveCarriesTheTask(t *testing.T) {
	caps, audits, _ := testCaps(t, oneSourceSettings, hostDevices,
		func() ([]byte, error) { return solidFrame(t, color.Black), nil })
	out, _, err := caps.Execute(context.Background(), "visual.observe",
		map[string]any{"source_id": "hdmi-primary", "task": "que error aparece"})
	if err != nil {
		t.Fatal(err)
	}
	if out["task"] != "que error aparece" {
		t.Fatalf("la intencion declarada tiene que viajar: %+v", out)
	}
	if (*audits)[0].tool != "visual.observe" ||
		!strings.Contains((*audits)[0].detail, "que error aparece") {
		t.Fatalf("la observacion se audita con su intencion: %+v", *audits)
	}
}

func TestVisualSnapshotRequiresExplicitSource(t *testing.T) {
	caps, _, _ := testCaps(t, oneSourceSettings, hostDevices, nil)
	if _, _, err := caps.Execute(context.Background(), "visual.snapshot", map[string]any{}); err == nil {
		t.Fatal("no hay captura sin decir de que fuente")
	}
	_, _, err := caps.Execute(context.Background(), "visual.snapshot",
		map[string]any{"source_id": "la-webcam-del-usuario"})
	if err == nil {
		t.Fatal("una fuente inexistente no se resuelve a otra cosa")
	}
}

func TestVisualCapabilitiesIgnoresForeignCapability(t *testing.T) {
	caps, _, _ := testCaps(t, oneSourceSettings, hostDevices, nil)
	out, handled, err := caps.Execute(context.Background(), "terminal.list", nil)
	if handled || out != nil || err != nil {
		t.Fatal("lo que no es visual.* no se atiende aca")
	}
}

func TestVisualCapabilityDefsDeclareRiskClasses(t *testing.T) {
	byName := map[string]string{}
	for _, def := range visualCapabilityDefs {
		byName[def["name"].(string)] = def["risk_class"].(string)
	}
	for _, name := range []string{"visual.sources.list", "visual.snapshot",
		"visual.observe", "visual.watch"} {
		if byName[name] == "" {
			t.Fatalf("falta declarar %s", name)
		}
	}
	// Vigilar arranca un proceso que emite eventos: no es una lectura.
	if byName["visual.watch"] != "reversible-write" {
		t.Fatalf("visual.watch tiene que declararse como escritura reversible: %s",
			byName["visual.watch"])
	}
	if byName["visual.snapshot"] != "read" {
		t.Fatalf("un snapshot no muta nada: %s", byName["visual.snapshot"])
	}
}

func TestJarvisRegisterPayloadIncludesVisualCapabilities(t *testing.T) {
	if got := len(jarvisAllCapabilities(true)); got != len(jarvisCapabilities)+len(visualCapabilityDefs) {
		t.Fatalf("el registro tiene que declarar terminal.* y visual.*: %d", got)
	}
	if got := len(jarvisAllCapabilities(false)); got != len(jarvisCapabilities) {
		t.Fatalf("sin soporte visual no se declaran capabilities que no se pueden cumplir: %d", got)
	}
}

// --- watch ---

func TestVisualWatchEmitsEventsWithoutFrames(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	base := solidFrame(t, color.Black)
	changed := halfFrame(t, color.Black, color.White)
	caps, _, events := testCaps(t, oneSourceSettings, hostDevices,
		func() ([]byte, error) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			// primer frame: linea de base; a partir del segundo, cambio real
			if calls == 1 {
				return base, nil
			}
			return changed, nil
		})
	defer caps.StopAll()

	out, _, err := caps.Execute(context.Background(), "visual.watch", map[string]any{
		"source_id": "hdmi-primary", "action": "start",
		"interval_s": 1, "task": "avisame cuando termine",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out["watching"] != true {
		t.Fatalf("el watch deberia arrancar: %+v", out)
	}

	var change map[string]any
	deadline := time.Now().Add(8 * time.Second)
	for change == nil && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		mu.Lock()
		for _, e := range *events {
			if e["kind"] == "visual.change" {
				change = e
			}
		}
		mu.Unlock()
	}
	if change == nil {
		t.Fatalf("no llego el evento de cambio tras %d capturas: %+v", calls, *events)
	}

	if _, bad := change["image_base64"]; bad {
		t.Fatal("un evento de cambio NUNCA lleva la imagen")
	}
	if change["needs_observation"] != true {
		t.Fatalf("el evento invita a observar, no observa solo: %+v", change)
	}
	if change["task"] != "avisame cuando termine" {
		t.Fatalf("la tarea del watch tiene que viajar en el evento: %+v", change)
	}
	if change["source_id"] != "hdmi-primary" {
		t.Fatalf("el evento tiene que decir de que fuente habla: %+v", change)
	}
	if _, ok := change["frame"]; !ok {
		t.Fatalf("el evento lleva metadata del frame (no el frame): %+v", change)
	}
}
func TestVisualWatchStartStopStatus(t *testing.T) {
	caps, _, _ := testCaps(t, oneSourceSettings, hostDevices,
		func() ([]byte, error) { return solidFrame(t, color.Black), nil })
	defer caps.StopAll()
	ctx := context.Background()

	if _, _, err := caps.Execute(ctx, "visual.watch", map[string]any{
		"source_id": "hdmi-primary", "interval_s": 30}); err != nil {
		t.Fatal(err)
	}
	out, _, _ := caps.Execute(ctx, "visual.watch", map[string]any{"action": "status"})
	if len(out["watches"].([]map[string]any)) != 1 {
		t.Fatalf("deberia haber un watch vivo: %+v", out)
	}

	// Arrancar dos veces la misma fuente reinicia, no acumula.
	if _, _, err := caps.Execute(ctx, "visual.watch", map[string]any{
		"source_id": "hdmi-primary", "interval_s": 30}); err != nil {
		t.Fatal(err)
	}
	out, _, _ = caps.Execute(ctx, "visual.watch", map[string]any{"action": "status"})
	if len(out["watches"].([]map[string]any)) != 1 {
		t.Fatalf("no se acumulan watches duplicados: %+v", out)
	}

	out, _, _ = caps.Execute(ctx, "visual.watch", map[string]any{
		"source_id": "hdmi-primary", "action": "stop"})
	if out["stopped"] != true {
		t.Fatalf("el stop tiene que confirmar: %+v", out)
	}
	out, _, _ = caps.Execute(ctx, "visual.watch", map[string]any{"action": "status"})
	if len(out["watches"].([]map[string]any)) != 0 {
		t.Fatalf("despues del stop no queda nada mirando: %+v", out)
	}
}

func TestVisualWatchDeniedWhenAIVisionOff(t *testing.T) {
	settings := `{"nexus:visualsources": [
	  {"id": "hdmi-primary", "label": "Banco", "aivision": "off",
	   "device": {"vid": "534d", "pid": "2109"}}]}`
	caps, audits, _ := testCaps(t, settings, hostDevices,
		func() ([]byte, error) { return solidFrame(t, color.Black), nil })
	defer caps.StopAll()
	if _, _, err := caps.Execute(context.Background(), "visual.watch",
		map[string]any{"source_id": "hdmi-primary"}); err == nil {
		t.Fatal("vigilar es observar: con ai_vision=off no hay watch")
	}
	if (*audits)[0].decision != "denied_ai_vision_off" {
		t.Fatalf("la denegacion se audita: %+v", *audits)
	}
}

func TestVisualWatchRejectsUnknownAction(t *testing.T) {
	caps, _, _ := testCaps(t, oneSourceSettings, hostDevices, nil)
	if _, _, err := caps.Execute(context.Background(), "visual.watch",
		map[string]any{"source_id": "hdmi-primary", "action": "explotar"}); err == nil {
		t.Fatal("una accion desconocida tiene que fallar explicita")
	}
}

func TestVisualWatchEndsWhenSourceIsLost(t *testing.T) {
	caps, _, events := testCaps(t, oneSourceSettings, hostDevices,
		func() ([]byte, error) { return nil, visualErr(ErrDeviceRemoved, "se desenchufo") })
	defer caps.StopAll()

	if _, _, err := caps.Execute(context.Background(), "visual.watch", map[string]any{
		"source_id": "hdmi-primary", "interval_s": 1}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		for _, e := range *events {
			if e["kind"] != "visual.watch.ended" {
				continue
			}
			if e["reason"] != "source_lost" || e["error_code"] != ErrDeviceRemoved {
				t.Fatalf("el fin tiene que explicar por que: %+v", e)
			}
			// y no queda nada girando contra un device ausente
			out, _, _ := caps.Execute(context.Background(), "visual.watch",
				map[string]any{"action": "status"})
			if len(out["watches"].([]map[string]any)) != 0 {
				t.Fatalf("el watch muerto no puede seguir listado: %+v", out)
			}
			return
		}
	}
	t.Fatalf("el watch tiene que terminar y avisar: %+v", *events)
}
func TestVisualWatchSkipsQuietlyWhileViewerHoldsDevice(t *testing.T) {
	// El usuario abre el bloque: el device queda tomado. El watch no debe
	// reportar eso como perdida de la fuente ni terminar.
	var mu sync.Mutex
	calls := 0
	caps, _, events := testCaps(t, oneSourceSettings, hostDevices,
		func() ([]byte, error) {
			mu.Lock()
			calls++
			mu.Unlock()
			return nil, visualErr(ErrDeviceBusy, "viewer adjunto")
		})
	defer caps.StopAll()

	if _, _, err := caps.Execute(context.Background(), "visual.watch", map[string]any{
		"source_id": "hdmi-primary", "interval_s": 1}); err != nil {
		t.Fatal(err)
	}
	// mas de un tick del intervalo minimo
	time.Sleep(2500 * time.Millisecond)
	mu.Lock()
	seen := calls
	for _, e := range *events {
		if e["kind"] == "visual.watch.ended" {
			mu.Unlock()
			t.Fatalf("un device ocupado por el viewer no termina el watch: %+v", e)
		}
	}
	mu.Unlock()
	out, _, _ := caps.Execute(context.Background(), "visual.watch",
		map[string]any{"action": "status"})
	if len(out["watches"].([]map[string]any)) != 1 {
		t.Fatal("el watch sigue vivo esperando que el viewer suelte el device")
	}
	if seen == 0 {
		t.Fatal("el watch deberia haber intentado capturar")
	}
}
func TestVisualWatchStopAllLeavesNothingRunning(t *testing.T) {
	caps, _, _ := testCaps(t, oneSourceSettings, hostDevices,
		func() ([]byte, error) { return solidFrame(t, color.Black), nil })
	if _, _, err := caps.Execute(context.Background(), "visual.watch",
		map[string]any{"source_id": "hdmi-primary", "interval_s": 30}); err != nil {
		t.Fatal(err)
	}
	caps.StopAll()
	out, _, _ := caps.Execute(context.Background(), "visual.watch",
		map[string]any{"action": "status"})
	if len(out["watches"].([]map[string]any)) != 0 {
		t.Fatalf("al apagar el agente no queda nada mirando: %+v", out)
	}
}
