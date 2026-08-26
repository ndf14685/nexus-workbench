// Copyright 2026, Nexus
// SPDX-License-Identifier: Apache-2.0

package main

// Entrega de avisos al escritorio.
//
// Este modulo NO decide si hay que avisar ni por que canal: eso ya lo decidio
// la puerta de atencion del cerebro. Aca solo se entrega, y se responde si se
// entrego — que es lo que convierte "te avise" en algo verificable.
//
// Dos reglas duras, y las dos son de seguridad de audio:
//
//	el toast SIEMPRE es silencioso   -> el sonido es otro canal, con otro permiso
//	el ding es una sola reproduccion -> sin repeticion, sin cola, sin loop

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// Canales de entrega. Mismos nombres que usa la politica de atencion del
	// cerebro, para no traducir en el medio.
	ChannelToast = "window_toast"
	ChannelChime = "soft_chime"
)

var notificationCapabilityDefs = []map[string]any{
	{"name": "notification.show",
		"description": "aviso discreto en el escritorio: toast nativo silencioso o un ding corto",
		"risk_class":  "reversible-write"},
}

// ErrChimeUnsupported: la plataforma no puede reproducir el ding. El cerebro
// lo usa para caer al canal visual — nunca para subir a voz.
var ErrChimeUnsupported = errors.New("chime_unsupported")

// ChimePlayer reproduce el ding una vez. Inyectable para poder testear sin
// placa de audio.
type ChimePlayer func(ctx context.Context) error

type NotificationCapabilities struct {
	runWsh func(ctx context.Context, conn string, tabId string, args ...string) (string, error)
	tabId  func() (string, error)
	chime  ChimePlayer
	audit  func(tool, blockId, detail, decision string)
	clock  func() time.Time
}

func NewNotificationCapabilities(
	runWsh func(ctx context.Context, conn string, tabId string, args ...string) (string, error),
	tabId func() (string, error), chime ChimePlayer,
	audit func(tool, blockId, detail, decision string)) *NotificationCapabilities {
	return &NotificationCapabilities{runWsh: runWsh, tabId: tabId, chime: chime,
		audit: audit, clock: time.Now}
}

// Execute atiende notification.show. handled=false si la capability es de otro
// modulo.
func (nc *NotificationCapabilities) Execute(ctx context.Context, capability string,
	args map[string]any) (map[string]any, bool, error) {
	if capability != "notification.show" {
		return nil, false, nil
	}
	str := func(key string) string {
		value, _ := args[key].(string)
		return strings.TrimSpace(value)
	}
	body := str("body")
	if body == "" {
		return nil, true, fmt.Errorf("body vacio")
	}
	title := str("title")
	if title == "" {
		title = "Yoshi"
	}
	channel := str("channel")
	if channel == "" {
		channel = ChannelToast
	}
	correlation := str("correlation_id")
	started := nc.clock()

	var err error
	switch channel {
	case ChannelToast:
		err = nc.toast(ctx, title, body)
	case ChannelChime:
		err = nc.ding(ctx)
	default:
		return nil, true, fmt.Errorf("canal desconocido: %s", channel)
	}
	elapsed := nc.clock().Sub(started).Milliseconds()
	if err != nil {
		nc.auditf(channel, correlation, "failed: "+err.Error())
		return nil, true, err
	}
	nc.auditf(channel, correlation, "delivered")
	return map[string]any{
		"delivered":      true,
		"channel":        channel,
		"correlation_id": correlation,
		"severity":       str("severity"),
		"elapsed_ms":     elapsed,
	}, true, nil
}

// toast: notificacion nativa del sistema, SIEMPRE silenciosa (-s). Que suene o
// no es decision de otro canal; un toast que hace ruido seria audio sin permiso
// de audio.
func (nc *NotificationCapabilities) toast(ctx context.Context, title, body string) error {
	tabId, err := nc.tabId()
	if err != nil {
		return err
	}
	_, err = nc.runWsh(ctx, "", tabId, "notify", body, "-t", title, "-s")
	return err
}

func (nc *NotificationCapabilities) ding(ctx context.Context) error {
	if nc.chime == nil {
		return ErrChimeUnsupported
	}
	return nc.chime(ctx)
}

func (nc *NotificationCapabilities) auditf(channel, correlation, decision string) {
	if nc.audit == nil {
		return
	}
	nc.audit("notification.show", "", "channel="+channel+" correlation="+correlation, decision)
}

// --- el sonido ----------------------------------------------------------------

const (
	chimeSampleRate = 44100
	chimeMillis     = 180
	// Bajo a proposito: un aviso de fondo no compite con lo que estas
	// escuchando. La salida del escritorio es un endpoint compartido.
	chimePeak = 0.16
	chimeFile = "nexus-chime.wav"
)

// chimeWAV sintetiza el ding: dos parciales con caida exponencial, con entrada
// y salida suavizadas para que no chasquee. Se genera en vez de versionar un
// binario, asi el sonido se puede leer y discutir como codigo.
func chimeWAV() []byte {
	samples := chimeSampleRate * chimeMillis / 1000
	pcm := new(bytes.Buffer)
	attack := float64(chimeSampleRate) * 0.006 // 6 ms
	for i := 0; i < samples; i++ {
		t := float64(i) / float64(chimeSampleRate)
		env := math.Exp(-t / 0.055)
		if float64(i) < attack {
			env *= float64(i) / attack
		}
		if rest := float64(samples - i); rest < attack {
			env *= rest / attack
		}
		v := 0.75*math.Sin(2*math.Pi*880*t) + 0.25*math.Sin(2*math.Pi*1320*t)
		_ = binary.Write(pcm, binary.LittleEndian, int16(v*env*chimePeak*32767))
	}
	data := pcm.Bytes()
	out := new(bytes.Buffer)
	out.WriteString("RIFF")
	_ = binary.Write(out, binary.LittleEndian, uint32(36+len(data)))
	out.WriteString("WAVEfmt ")
	_ = binary.Write(out, binary.LittleEndian, uint32(16)) // tamano del bloque fmt
	_ = binary.Write(out, binary.LittleEndian, uint16(1))  // PCM
	_ = binary.Write(out, binary.LittleEndian, uint16(1))  // mono
	_ = binary.Write(out, binary.LittleEndian, uint32(chimeSampleRate))
	_ = binary.Write(out, binary.LittleEndian, uint32(chimeSampleRate*2)) // byte rate
	_ = binary.Write(out, binary.LittleEndian, uint16(2))                 // block align
	_ = binary.Write(out, binary.LittleEndian, uint16(16))                // bits
	out.WriteString("data")
	_ = binary.Write(out, binary.LittleEndian, uint32(len(data)))
	out.Write(data)
	return out.Bytes()
}

// EnsureChimeFile deja el wav en disco una sola vez y devuelve su ruta.
func EnsureChimeFile(dir string) (string, error) {
	path := filepath.Join(dir, chimeFile)
	wav := chimeWAV()
	if info, err := os.Stat(path); err == nil && info.Size() == int64(len(wav)) {
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, wav, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// MakeChimePlayer devuelve el reproductor del host, o nil si esta plataforma no
// puede sonar: el cerebro cae al canal visual y lo deja anotado.
func MakeChimePlayer(dir string) ChimePlayer {
	if !chimeSupported() {
		return nil
	}
	path, err := EnsureChimeFile(dir)
	if err != nil {
		return nil
	}
	return func(ctx context.Context) error {
		return playChimeFile(path)
	}
}
