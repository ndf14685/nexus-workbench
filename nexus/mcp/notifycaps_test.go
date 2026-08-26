// Copyright 2026, Nexus
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type wshCall struct {
	conn  string
	tabId string
	args  []string
}

func fakeNotifier(t *testing.T) (*NotificationCapabilities, *[]wshCall) {
	t.Helper()
	calls := &[]wshCall{}
	run := func(ctx context.Context, conn string, tabId string, args ...string) (string, error) {
		*calls = append(*calls, wshCall{conn: conn, tabId: tabId, args: args})
		return "ok", nil
	}
	nc := NewNotificationCapabilities(run, func() (string, error) { return "tab-1", nil }, nil, nil)
	return nc, calls
}

func TestToastIsAlwaysSilent(t *testing.T) {
	// El sonido es otro canal con otro permiso: un toast que suena seria audio
	// que nadie autorizo.
	nc, calls := fakeNotifier(t)
	out, handled, err := nc.Execute(context.Background(), "notification.show",
		map[string]any{"title": "Yoshi", "body": "Deploy terminado",
			"correlation_id": "c-1"})
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if out["delivered"] != true || out["channel"] != ChannelToast {
		t.Fatalf("salida inesperada: %v", out)
	}
	if out["correlation_id"] != "c-1" {
		t.Fatalf("perdio la correlacion: %v", out)
	}
	if len(*calls) != 1 {
		t.Fatalf("llamadas a wsh: %d", len(*calls))
	}
	args := strings.Join((*calls)[0].args, " ")
	if !strings.Contains(args, "notify Deploy terminado -t Yoshi") {
		t.Fatalf("comando raro: %q", args)
	}
	if !strings.HasSuffix(args, " -s") {
		t.Fatalf("el toast no salio silencioso: %q", args)
	}
}

func TestTitleDefaultsToYoshi(t *testing.T) {
	nc, calls := fakeNotifier(t)
	if _, _, err := nc.Execute(context.Background(), "notification.show",
		map[string]any{"body": "algo"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join((*calls)[0].args, " "), "-t Yoshi") {
		t.Fatalf("sin titulo por defecto: %v", (*calls)[0].args)
	}
}

func TestEmptyBodyIsRejected(t *testing.T) {
	nc, calls := fakeNotifier(t)
	_, handled, err := nc.Execute(context.Background(), "notification.show",
		map[string]any{"title": "Yoshi", "body": "   "})
	if !handled || err == nil {
		t.Fatalf("un aviso sin texto no es un aviso: handled=%v err=%v", handled, err)
	}
	if len(*calls) != 0 {
		t.Fatal("igual toco el escritorio")
	}
}

func TestOtherCapabilitiesAreNotHandled(t *testing.T) {
	nc, _ := fakeNotifier(t)
	if _, handled, _ := nc.Execute(context.Background(), "visual.snapshot", nil); handled {
		t.Fatal("se comio una capability ajena")
	}
}

func TestChimeUsesThePlayerAndNotTheDesktop(t *testing.T) {
	played := 0
	run := func(ctx context.Context, conn string, tabId string, args ...string) (string, error) {
		t.Fatalf("el ding no debe abrir ninguna ventana: %v", args)
		return "", nil
	}
	nc := NewNotificationCapabilities(run, func() (string, error) { return "tab-1", nil },
		func(ctx context.Context) error { played++; return nil }, nil)
	out, _, err := nc.Execute(context.Background(), "notification.show",
		map[string]any{"body": "listo", "channel": ChannelChime})
	if err != nil {
		t.Fatal(err)
	}
	if played != 1 {
		t.Fatalf("reproducciones: %d (tiene que ser exactamente una)", played)
	}
	if out["channel"] != ChannelChime {
		t.Fatalf("canal mal reportado: %v", out)
	}
}

func TestChimeWithoutPlayerSaysSoInsteadOfPretending(t *testing.T) {
	nc, _ := fakeNotifier(t) // sin player
	_, handled, err := nc.Execute(context.Background(), "notification.show",
		map[string]any{"body": "listo", "channel": ChannelChime})
	if !handled || !errors.Is(err, ErrChimeUnsupported) {
		t.Fatalf("tiene que decir que no puede: handled=%v err=%v", handled, err)
	}
}

func TestUnknownChannelIsRefused(t *testing.T) {
	nc, calls := fakeNotifier(t)
	if _, _, err := nc.Execute(context.Background(), "notification.show",
		map[string]any{"body": "x", "channel": "voice"}); err == nil {
		t.Fatal("la voz no se entrega por aca")
	}
	if len(*calls) != 0 {
		t.Fatal("entrego igual")
	}
}

func TestTheChimeIsShortAndQuiet(t *testing.T) {
	wav := chimeWAV()
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		t.Fatal("no es un wav")
	}
	rate := binary.LittleEndian.Uint32(wav[24:28])
	bits := binary.LittleEndian.Uint16(wav[34:36])
	dataLen := binary.LittleEndian.Uint32(wav[40:44])
	if rate != chimeSampleRate || bits != 16 {
		t.Fatalf("formato inesperado: %d Hz %d bits", rate, bits)
	}
	millis := int(dataLen) * 1000 / int(rate*2)
	if millis > 999 {
		t.Fatalf("un ding dura menos de un segundo, este dura %d ms", millis)
	}
	var peak int16
	for i := 44; i+1 < len(wav); i += 2 {
		v := int16(binary.LittleEndian.Uint16(wav[i : i+2]))
		if v > peak {
			peak = v
		}
	}
	if peak > 8191 { // 25% de escala
		t.Fatalf("suena demasiado fuerte: pico %d", peak)
	}
	if peak < 655 { // 2% de escala
		t.Fatalf("no se va a escuchar: pico %d", peak)
	}
	// arranca en cero: un click al principio es lo que hace que un aviso
	// discreto se sienta agresivo
	if first := int16(binary.LittleEndian.Uint16(wav[44:46])); first != 0 {
		t.Fatalf("empieza con un salto: %d", first)
	}
}

func TestChimeFileIsWrittenOnce(t *testing.T) {
	dir := t.TempDir()
	path, err := EnsureChimeFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != dir {
		t.Fatalf("ruta rara: %s", path)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EnsureChimeFile(dir)
	if err != nil || again != path {
		t.Fatalf("no fue idempotente: %v %v", again, err)
	}
	info2, _ := os.Stat(path)
	if info2.ModTime() != info.ModTime() {
		t.Fatal("lo reescribio sin necesidad")
	}
}

func TestTheCapabilityIsDeclaredForTheBrain(t *testing.T) {
	found := false
	for _, cap := range notificationCapabilityDefs {
		if cap["name"] == "notification.show" {
			found = true
			if cap["risk_class"] == "" {
				t.Fatal("sin clase de riesgo el cerebro la rechaza")
			}
		}
	}
	if !found {
		t.Fatal("no se registra: el cerebro no la puede invocar")
	}
}
