// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Subcomando `visual`: superficie de diagnóstico del provider de fuentes
// visuales. Existe para poder responder "¿ve el host la capturadora?" sin
// abrir la app ni el cerebro, que es la primera pregunta de cualquier
// troubleshooting (nexus/docs/VISUAL_SOURCES.md).
//
//	nexus-workbench-mcp visual devices              # lo que ve el host
//	nexus-workbench-mcp visual list                 # config contrastada con el host
//	nexus-workbench-mcp visual snapshot -source id  # metadata del frame, sin escribirlo
//	nexus-workbench-mcp visual snapshot -source id -out frame.jpg
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"
)

func runVisualCLI(args []string) {
	fs := flag.NewFlagSet("visual", flag.ExitOnError)
	var settingsPath, ffmpegBin, sourceId, outPath string
	var dev bool
	fs.StringVar(&settingsPath, "settings", "", "ruta a settings.json (default: <configdir>/settings.json)")
	fs.StringVar(&ffmpegBin, "ffmpeg", "", "ruta al binario ffmpeg (default: ffmpeg del PATH)")
	fs.StringVar(&sourceId, "source", "", "id de la fuente visual")
	fs.StringVar(&outPath, "out", "", "escribir el frame en este archivo (sin esto, sólo metadata)")
	fs.BoolVar(&dev, "dev", false, "usar los directorios waveterm-dev")
	sub := ""
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		sub = args[0]
		args = args[1:]
	}
	fs.Parse(args)

	if settingsPath == "" {
		settingsPath = ResolveSettingsPath("", dev)
	}
	reg := NewVisualSourceRegistry(settingsPath, ffmpegBin)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch sub {
	case "devices":
		devices, err := NewFFmpegEnumerator(ffmpegBin).Enumerate(ctx)
		if err != nil {
			fail("enumerando dispositivos: %v", err)
		}
		emitJSON(map[string]any{"devices": devices})
	case "list":
		list, err := reg.List(ctx)
		if err != nil {
			fail("listando fuentes: %v", err)
		}
		emitJSON(map[string]any{"settings": settingsPath, "sources": list})
	case "snapshot":
		if sourceId == "" {
			fail("falta -source <id> (ver `visual list`)")
		}
		data, res, err := reg.Snapshot(ctx, sourceId)
		if err != nil {
			var ve *VisualError
			if errors.As(err, &ve) {
				emitJSON(map[string]any{"ok": false, "error_code": ve.Code, "error": ve.Detail, "source": res})
				os.Exit(1)
			}
			fail("snapshot: %v", err)
		}
		meta := DescribeFrame(data)
		out := map[string]any{"ok": true, "source": res, "frame": meta}
		if outPath != "" {
			// Escribir el frame es una acción explícita del operador, nunca el
			// comportamiento por defecto (§11: nada se persiste solo).
			if err := os.WriteFile(outPath, data, 0o600); err != nil {
				fail("escribiendo %s: %v", outPath, err)
			}
			out["written_to"] = outPath
		}
		emitJSON(out)
	default:
		fmt.Fprintln(os.Stderr, "uso: nexus-workbench-mcp visual <devices|list|snapshot> [flags]")
		os.Exit(2)
	}
}

func emitJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fail("serializando salida: %v", err)
	}
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
