// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// nexus-workbench-mcp: servidor MCP (stdio) que expone el Workbench Bridge
// (nexus/docs/BRIDGE.md) sobre la app Nexus Workbench en ejecución, envolviendo
// el CLI wsh con autenticación propia y gobernanza ADR-0004.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const ServerVersion = "0.1.0"

type App struct {
	wave      *WaveAccess
	catalog   *Catalog
	confirmer *Confirmer
	audit     *Auditor
	ctxGuard  *ContextDetector
	workspace string
}

func (app *App) tabId() (string, error) {
	return app.wave.ActiveTabId(app.workspace)
}

// resolveEnv acepta id del catálogo; "local" siempre existe implícitamente.
func (app *App) resolveEnv(id string) (*Environment, error) {
	if id == "" || id == "local" {
		return &Environment{Id: "local", Name: "Local", Kind: "local", Class: "personal"}, nil
	}
	return app.catalog.Get(id)
}

// gate aplica la política: ambientes prod/work/criticality-high y comandos
// destructivos requieren confirmación en dos fases.
func (app *App) gate(tool string, env *Environment, detail string, confirmToken string) (blockedMsg string) {
	return app.gateWithContext(tool, env, detail, confirmToken, EffectiveContext{})
}

// gateWithContext suma al gate el contexto efectivo del shell: un ambiente
// marcado lab cuyo kubeconfig apunta a producción tiene que escalar igual.
func (app *App) gateWithContext(tool string, env *Environment, detail string, confirmToken string, effective EffectiveContext) (blockedMsg string) {
	needs := env.NeedsConfirmation()
	reason := fmt.Sprintf("ambiente %s (class=%s)", env.Id, env.Class)
	if tool == "run_command" && IsDestructive(detail) {
		needs = true
		reason = "comando detectado como destructivo"
		if env.NeedsConfirmation() {
			reason += fmt.Sprintf(" en ambiente %s (class=%s)", env.Id, env.Class)
		}
	}
	if effective.LooksProduction() {
		needs = true
		reason = fmt.Sprintf("el %s activo es %q, que parece producción (el ambiente %s está declarado class=%s)",
			effective.Kind, effective.Name, env.Id, env.Class)
	}
	if !needs {
		return ""
	}
	if confirmToken != "" && app.confirmer.Check(confirmToken, tool, env.Id, detail) {
		app.audit.Log(tool, env.Id, detail, "confirmed")
		return ""
	}
	token := app.confirmer.Request(tool, env.Id, detail)
	app.audit.Log(tool, env.Id, detail, "confirmation_required")
	return fmt.Sprintf(
		"CONFIRMACIÓN REQUERIDA (%s). Mostrale al usuario la acción exacta [%s en %s: %s] y, "+
			"solo con su aprobación explícita, repetí la llamada con confirm_token=%q (expira en 2 minutos).",
		reason, tool, env.Id, detail, token)
}

func textResult(s string) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}, nil, nil
}

// redactedResult es la salida para todo lo que viene del ambiente (scrollback,
// stdout, metadata de bloques): texto arbitrario que puede traer credenciales.
// Los mensajes que genera la propia app (gate, status, catálogo) usan
// textResult: el confirm_token es un control de seguridad que el agente
// necesita recibir intacto, y la redacción genérica lo taparía.
func redactedResult(s string) (*mcp.CallToolResult, any, error) {
	return textResult(RedactForAgent(s))
}

// --- tool args ---

type EmptyArgs struct{}

type RunCommandArgs struct {
	Environment  string `json:"environment" jsonschema:"id del ambiente del catálogo (o 'local')"`
	Command      string `json:"command" jsonschema:"comando de shell a ejecutar en un bloque terminal visible"`
	Cwd          string `json:"cwd,omitempty" jsonschema:"directorio de trabajo opcional"`
	ConfirmToken string `json:"confirm_token,omitempty" jsonschema:"token devuelto por una llamada previa que requirió confirmación"`
}

type OpenTerminalArgs struct {
	Environment string `json:"environment" jsonschema:"id del ambiente del catálogo (o 'local')"`
}

type OpenFileArgs struct {
	Environment string `json:"environment" jsonschema:"id del ambiente del catálogo (o 'local')"`
	Path        string `json:"path" jsonschema:"archivo o directorio a abrir en un bloque preview"`
}

type TerminalOutputArgs struct {
	BlockId     string `json:"block_id" jsonschema:"id del bloque terminal (de run_command o list_blocks)"`
	LastCommand bool   `json:"last_command,omitempty" jsonschema:"solo la salida del último comando (requiere shell integration)"`
	StartLine   int    `json:"start_line,omitempty" jsonschema:"línea inicial (0 = principio)"`
}

type NotifyArgs struct {
	Message string `json:"message" jsonschema:"texto de la notificación de escritorio"`
	Title   string `json:"title,omitempty" jsonschema:"título opcional"`
}

func main() {
	var dataDir, wshPath, envsPath, auditPath, workspace string
	var dev bool
	flag.StringVar(&dataDir, "data-dir", "", "data dir de la app (default: autodetectar)")
	flag.StringVar(&wshPath, "wsh", "", "ruta al binario wsh (default: autodetectar)")
	flag.StringVar(&envsPath, "environments", "", "ruta a environments.yaml (default: <configdir-guess>)")
	flag.StringVar(&auditPath, "audit", "", "ruta del log de auditoría JSONL")
	flag.StringVar(&workspace, "workspace", "", "nombre del workspace destino (default: primero activo)")
	flag.BoolVar(&dev, "dev", false, "usar los directorios waveterm-dev")
	flag.Parse()

	log.SetOutput(os.Stderr)

	resolvedData := ResolveDataDir(dataDir, dev)
	resolvedWsh, err := ResolveWshPath(wshPath)
	if err != nil {
		log.Fatalf("wsh: %v", err)
	}
	wave, err := MakeWaveAccess(resolvedData, resolvedWsh)
	if err != nil {
		log.Fatalf("no puedo acceder al motor (data dir %s): %v", resolvedData, err)
	}
	if envsPath == "" {
		envsPath = os.Getenv("NEXUS_ENVIRONMENTS_FILE")
	}
	if envsPath == "" {
		log.Fatalf("falta --environments (o NEXUS_ENVIRONMENTS_FILE) apuntando a environments.yaml")
	}
	catalog, err := LoadCatalog(envsPath)
	if err != nil {
		log.Fatalf("catálogo: %v", err)
	}
	if auditPath == "" {
		auditPath = filepath.Join(resolvedData, "nexus-mcp-audit.jsonl")
	}

	app := &App{
		wave:      wave,
		catalog:   catalog,
		confirmer: MakeConfirmer(),
		audit:     MakeAuditor(auditPath),
		ctxGuard:  MakeContextDetector(wave),
		workspace: workspace,
	}

	server := mcp.NewServer(&mcp.Implementation{Name: "nexus-workbench", Version: ServerVersion}, nil)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_environments",
		Description: "Lista los ambientes del catálogo de Nexus Workbench con su clase de riesgo (lab/personal/work/prod).",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args EmptyArgs) (*mcp.CallToolResult, any, error) {
		var b strings.Builder
		b.WriteString("local — Local (kind=local, class=personal)\n")
		for _, e := range app.catalog.Environments {
			fmt.Fprintf(&b, "%s — %s (kind=%s, conn=%s, class=%s, criticality=%s)", e.Id, e.Name, e.Kind, e.ConnName(), e.Class, e.Criticality)
			if e.NeedsConfirmation() {
				b.WriteString(" [REQUIERE CONFIRMACIÓN]")
			}
			b.WriteString("\n")
		}
		return textResult(b.String())
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "run_command",
		Description: "Ejecuta un comando en un bloque terminal NUEVO y VISIBLE de Nexus Workbench, en el ambiente indicado. " +
			"Devuelve el block id para leer la salida con get_terminal_output. Ambientes prod/work y comandos destructivos requieren confirmación en dos fases.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args RunCommandArgs) (*mcp.CallToolResult, any, error) {
		env, err := app.resolveEnv(args.Environment)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		if strings.TrimSpace(args.Command) == "" {
			return textResult("ERROR: command vacío")
		}
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		// sólo interrogamos el shell si el destino real del comando lo decide un
		// contexto ambiental (kubectl, aws, gcloud, terraform)
		var effective EffectiveContext
		if kind := CommandContextKind(args.Command); kind != "" {
			effective = app.ctxGuard.Detect(ctx, env, tabId, kind)
		}
		if msg := app.gateWithContext("run_command", env, args.Command, args.ConfirmToken, effective); msg != "" {
			return textResult(msg)
		}
		wshArgs := []string{"run"}
		if args.Cwd != "" {
			wshArgs = append(wshArgs, "--cwd", args.Cwd)
		}
		wshArgs = append(wshArgs, "-c", args.Command)
		out, err := app.wave.RunWsh(ctx, env.ConnName(), tabId, wshArgs...)
		if err != nil {
			app.audit.Log("run_command", env.Id, args.Command, "error: "+err.Error())
			return textResult("ERROR: " + err.Error())
		}
		app.audit.Log("run_command", env.Id, args.Command, "executed")
		return redactedResult(out)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "open_terminal",
		Description: "Abre un bloque terminal interactivo nuevo en el ambiente indicado (shell del ambiente; el usuario lo ve y lo controla).",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args OpenTerminalArgs) (*mcp.CallToolResult, any, error) {
		env, err := app.resolveEnv(args.Environment)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		wshArgs := []string{"createblock", "term", "controller=shell"}
		if conn := env.ConnName(); conn != "" {
			wshArgs = append(wshArgs, "connection="+conn)
		}
		out, err := app.wave.RunWsh(ctx, env.ConnName(), tabId, wshArgs...)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		app.audit.Log("open_terminal", env.Id, "", "executed")
		return textResult(out)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "open_file",
		Description: "Abre un archivo o directorio en un bloque preview (editor Monaco / listado) en el ambiente indicado.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args OpenFileArgs) (*mcp.CallToolResult, any, error) {
		env, err := app.resolveEnv(args.Environment)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		if args.Path == "" {
			return textResult("ERROR: path vacío")
		}
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		out, err := app.wave.RunWsh(ctx, env.ConnName(), tabId, "view", args.Path)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		app.audit.Log("open_file", env.Id, args.Path, "executed")
		return textResult(out)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "get_terminal_output",
		Description: "Lee el scrollback de un bloque terminal (la 'vista' del agente sobre lo que pasó). " +
			"Con last_command=true devuelve solo la salida del último comando.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args TerminalOutputArgs) (*mcp.CallToolResult, any, error) {
		if args.BlockId == "" {
			return textResult("ERROR: block_id vacío")
		}
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		// wsh exige el ORef completo ("block:<uuid>") fuera de un contexto de bloque
		blockRef := args.BlockId
		if !strings.HasPrefix(blockRef, "block:") {
			blockRef = "block:" + blockRef
		}
		wshArgs := []string{"termscrollback", "-b", blockRef}
		if args.LastCommand {
			wshArgs = append(wshArgs, "--lastcommand")
		}
		if args.StartLine > 0 {
			wshArgs = append(wshArgs, "--start", strconv.Itoa(args.StartLine))
		}
		out, err := app.wave.RunWsh(ctx, "", tabId, wshArgs...)
		if err != nil {
			// termscrollback depende del renderer (ruta feblock); si la vista no
			// está montada, caemos al blockfile "main" del filestore.
			raw, ferr := app.wave.RunWsh(ctx, "", tabId, "readfile", "term", "-b", blockRef)
			if ferr != nil {
				return textResult("ERROR: " + err.Error())
			}
			return redactedResult(tailLines(stripAnsi(raw), 200))
		}
		return redactedResult(out)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_blocks",
		Description: "Lista los bloques abiertos en la app (id, tab, vista, conexión) en JSON.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args EmptyArgs) (*mcp.CallToolResult, any, error) {
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		out, err := app.wave.RunWsh(ctx, "", tabId, "blocks", "list", "--json")
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		return redactedResult(out)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "notify_user",
		Description: "Muestra una notificación de escritorio al usuario a través de la app.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args NotifyArgs) (*mcp.CallToolResult, any, error) {
		if args.Message == "" {
			return textResult("ERROR: message vacío")
		}
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		title := args.Title
		if title == "" {
			title = "Jarvis"
		}
		out, err := app.wave.RunWsh(ctx, "", tabId, "notify", args.Message, "-t", title)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		return textResult(out)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_status",
		Description: "Diagnóstico del puente: data dir, socket, wsh, catálogo y si la app está accesible.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args EmptyArgs) (*mcp.CallToolResult, any, error) {
		var b strings.Builder
		fmt.Fprintf(&b, "data dir: %s\n", app.wave.DataDir)
		fmt.Fprintf(&b, "wsh: %s\n", app.wave.WshPath)
		fmt.Fprintf(&b, "socket: %s ", app.wave.SockPath())
		if _, err := os.Stat(app.wave.SockPath()); err == nil {
			b.WriteString("(existe)\n")
		} else {
			b.WriteString("(NO existe — ¿app abierta?)\n")
		}
		fmt.Fprintf(&b, "ambientes en catálogo: %d\n", len(app.catalog.Environments))
		tabId, err := app.tabId()
		if err != nil {
			fmt.Fprintf(&b, "tab activo: ERROR %v\n", err)
		} else {
			fmt.Fprintf(&b, "tab activo: %s\n", tabId)
			if out, err := app.wave.RunWsh(ctx, "", tabId, "version"); err == nil {
				fmt.Fprintf(&b, "conexión RPC: OK (%s)\n", out)
			} else {
				fmt.Fprintf(&b, "conexión RPC: FALLÓ — %v\n", err)
			}
		}
		return textResult(b.String())
	})

	log.Printf("nexus-workbench-mcp %s — data=%s wsh=%s envs=%s audit=%s",
		ServerVersion, resolvedData, resolvedWsh, envsPath, auditPath)
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("server: %v", err)
	}
}
