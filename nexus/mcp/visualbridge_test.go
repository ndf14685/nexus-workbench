// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// El arbitraje del dispositivo: quién entrega el frame cuando el viewer humano
// tiene la capturadora abierta.

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image/color"
	"testing"
)

// Salida real de `wsh blocks list --json` con un bloque HMI abierto y una
// terminal al lado.
const blocksListJSON = `[
  {"blockid":"b-term","meta":{"view":"term","controller":"shell"}},
  {"blockid":"b-hmi","meta":{"view":"visual","visual:source":"hdmi-primary","visual:viewer":true}}
]`

func TestParseVisualViewerBlock(t *testing.T) {
	if got := parseVisualViewerBlock(blocksListJSON, "hdmi-primary"); got != "b-hmi" {
		t.Fatalf("esperaba el bloque HMI que tiene el device, hubo %q", got)
	}
	// Otra fuente: ese bloque no la tiene tomada.
	if got := parseVisualViewerBlock(blocksListJSON, "hdmi-lab"); got != "" {
		t.Fatalf("no puede matchear una fuente distinta: %q", got)
	}
}

func TestParseVisualViewerBlockIgnoresBlocksThatDoNotHoldTheDevice(t *testing.T) {
	// Un bloque HMI offline (sin visual:viewer) no puede entregar ningún frame:
	// tratarlo como viewer haría fallar todos los snapshots.
	offline := `[{"blockid":"b-hmi","meta":{"view":"visual","visual:source":"hdmi-primary"}}]`
	if got := parseVisualViewerBlock(offline, "hdmi-primary"); got != "" {
		t.Fatalf("un bloque que no tomó el device no es viewer: %q", got)
	}
	otherView := `[{"blockid":"b-x","meta":{"view":"web","visual:viewer":true}}]`
	if got := parseVisualViewerBlock(otherView, "hdmi-primary"); got != "" {
		t.Fatalf("un bloque que no es visual no puede ser el viewer: %q", got)
	}
}

func TestParseVisualViewerBlockToleratesGarbage(t *testing.T) {
	// wsh caído o salida inesperada: sin viewer, y el snapshot cae al provider.
	if got := parseVisualViewerBlock("no es json", "hdmi-primary"); got != "" {
		t.Fatalf("una salida ilegible no puede inventar un viewer: %q", got)
	}
	if got := parseVisualViewerBlock("[]", "hdmi-primary"); got != "" {
		t.Fatalf("sin bloques no hay viewer: %q", got)
	}
}

func TestSnapshotDelegatesToTheViewerThatHoldsTheDevice(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	want := solidFrame(t, color.White)
	ffmpegCalled := false
	reg.snapshotFn = func(context.Context, *VisualSourceRegistry, *ResolvedSource) ([]byte, error) {
		ffmpegCalled = true
		return nil, visualErr(ErrDeviceBusy, "no deberia llegar aca")
	}
	var capturedBlock string
	reg.SetViewerBridge(
		func(_ context.Context, sourceId string) string {
			if sourceId == "hdmi-primary" {
				return "b-hmi"
			}
			return ""
		},
		func(_ context.Context, blockId string) ([]byte, error) {
			capturedBlock = blockId
			return want, nil
		})

	data, res, err := reg.Snapshot(context.Background(), "hdmi-primary")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, want) {
		t.Fatal("el frame tiene que venir del viewer")
	}
	if capturedBlock != "b-hmi" {
		t.Fatalf("se le pidió al bloque equivocado: %q", capturedBlock)
	}
	if ffmpegCalled {
		t.Fatal("con el viewer adjunto NO se puede abrir un segundo consumidor del device")
	}
	if res.Status != StatusBusy {
		t.Fatalf("la fuente se reporta ocupada por el viewer: %+v", res)
	}
}

func TestSnapshotUsesProviderWhenNoViewerHoldsTheDevice(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	want := solidFrame(t, color.Black)
	reg.snapshotFn = func(context.Context, *VisualSourceRegistry, *ResolvedSource) ([]byte, error) {
		return want, nil
	}
	reg.SetViewerBridge(
		func(context.Context, string) string { return "" },
		func(context.Context, string) ([]byte, error) {
			t.Fatal("sin viewer no hay que molestar al bloque")
			return nil, nil
		})
	data, _, err := reg.Snapshot(context.Background(), "hdmi-primary")
	if err != nil || !bytes.Equal(data, want) {
		t.Fatalf("con el device libre captura el provider: %v", err)
	}
}

func TestSnapshotSurfacesViewerCaptureFailure(t *testing.T) {
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	reg.SetViewerBridge(
		func(context.Context, string) string { return "b-hmi" },
		func(context.Context, string) ([]byte, error) {
			return nil, visualErr(ErrStreamFailed, "la ventana no está renderizando")
		})
	_, _, err := reg.Snapshot(context.Background(), "hdmi-primary")
	var ve *VisualError
	if !errors.As(err, &ve) || ve.Code != ErrStreamFailed {
		t.Fatalf("el fallo del viewer tiene que llegar tipado: %v", err)
	}
}

func TestSnapshotWithoutBridgeStillReportsBusy(t *testing.T) {
	// Sin puente configurado (agente viejo, o el motor caído) el estado honesto
	// es DEVICE_BUSY, no un frame inventado ni una webcam distinta.
	reg, _ := testRegistry(t, oneSourceSettings, hostDevices)
	reg.SetViewerAttached("hdmi-primary", true)
	_, _, err := reg.Snapshot(context.Background(), "hdmi-primary")
	var ve *VisualError
	if !errors.As(err, &ve) || ve.Code != ErrDeviceBusy {
		t.Fatalf("esperaba DEVICE_BUSY, hubo %v", err)
	}
}

func TestFrameMetadataDetectsFormatFromTheImage(t *testing.T) {
	// El provider entrega JPEG; el viewer, PNG (captura de bloque del motor).
	// El formato lo dice la imagen, no el camino.
	jpg := DescribeFrame(solidFrame(t, color.Black))
	if jpg.Format != "jpeg" || jpg.Width == 0 {
		t.Fatalf("jpeg mal descrito: %+v", jpg)
	}
	png := DescribeFrame(pngFrame(t, color.White))
	if png.Format != "png" || png.Width == 0 {
		t.Fatalf("png mal descrito: %+v", png)
	}
	if jpg.ContentHash == png.ContentHash {
		t.Fatal("dos imágenes distintas no pueden compartir hash")
	}
}

func TestPerceptualHashWorksOnViewerPNGFrames(t *testing.T) {
	// El watch tiene que poder comparar frames que vienen del viewer.
	a := PerceptualHash(pngFrame(t, color.Black))
	b := PerceptualHash(pngHalfFrame(t, color.Black, color.White))
	if a == "" || b == "" {
		t.Fatal("un PNG del viewer tiene que hashear")
	}
	if a == b {
		t.Fatal("imágenes distintas, hashes distintos")
	}
}

func TestViewerCaptureDecodesTheWshOutput(t *testing.T) {
	// `wsh screenshot --raw` emite base64 con salto de línea final.
	raw := solidFrame(t, color.Black)
	encoded := base64.StdEncoding.EncodeToString(raw) + "\n"
	agent := &JarvisAgent{
		tabId: func() (string, error) { return "tab-1", nil },
		runWsh: func(_ context.Context, _ string, _ string, args ...string) (string, error) {
			if args[0] != "screenshot" {
				t.Fatalf("comando inesperado: %v", args)
			}
			return encoded, nil
		},
	}
	got, err := agent.visualViewerCapture(context.Background(), "b-hmi")
	if err != nil || !bytes.Equal(got, raw) {
		t.Fatalf("no se decodificó la imagen del viewer: %v", err)
	}
}

func TestViewerCaptureRejectsGarbage(t *testing.T) {
	agent := &JarvisAgent{
		tabId:  func() (string, error) { return "tab-1", nil },
		runWsh: func(context.Context, string, string, ...string) (string, error) { return "no-base64!!", nil },
	}
	_, err := agent.visualViewerCapture(context.Background(), "b-hmi")
	var ve *VisualError
	if !errors.As(err, &ve) || ve.Code != ErrStreamFailed {
		t.Fatalf("una salida corrupta tiene que fallar tipada: %v", err)
	}
}
