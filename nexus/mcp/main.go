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
	runbooks  *RunbookCatalog
	approvals *ApprovalBroker
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
	return app.gateFull(tool, env, detail, confirmToken, effective, false)
}

// gateFull agrega forceConfirm para lo que el catálogo declara sensible aunque
// ningún patrón lo detecte: quien escribió el runbook sabe algo que el regex no.
func (app *App) gateFull(tool string, env *Environment, detail string, confirmToken string, effective EffectiveContext, forceConfirm bool) (blockedMsg string) {
	needs := env.NeedsConfirmation()
	reason := fmt.Sprintf("ambiente %s (class=%s)", env.Id, env.Class)
	if forceConfirm {
		needs = true
		reason = "la acción está declarada como destructiva en el catálogo"
	}
	if IsDestructive(detail) {
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
	// Con el broker activo la aprobación sale de la conversación: el agente no
	// recibe un token que pueda decidir usar por su cuenta.
	if app.approvals != nil && app.requiresHumanApproval(env, effective, forceConfirm, detail) {
		return app.requestHumanApproval(tool, env, detail, confirmToken, reason)
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

// requiresHumanApproval delimita qué sale de la conversación. No es todo lo que
// pide confirmación: un ambiente work de rutina sigue con el flujo en dos
// fases. Sale lo irreversible o lo que toca producción.
func (app *App) requiresHumanApproval(env *Environment, effective EffectiveContext, forceConfirm bool, detail string) bool {
	return env.Class == "prod" || effective.LooksProduction() || forceConfirm || IsDestructive(detail)
}

// requestHumanApproval publica la solicitud o consume una aprobación ya dada.
// El "token" que trae el agente acá es sólo el id de la solicitud: sirve para
// consultar, no para autorizar.
func (app *App) requestHumanApproval(tool string, env *Environment, detail string, requestId string, reason string) string {
	if requestId != "" {
		state, _ := app.approvals.State(requestId)
		switch state {
		case ApprovalApproved:
			app.approvals.Resolve(requestId)
			app.audit.Log(tool, env.Id, detail, "human_approved")
			return ""
		case ApprovalDenied:
			app.approvals.Resolve(requestId)
			app.audit.Log(tool, env.Id, detail, "human_denied")
			return fmt.Sprintf("RECHAZADO por el usuario (solicitud %s). No reintentes esta acción.", requestId)
		case ApprovalPending:
			return fmt.Sprintf("La solicitud %s sigue esperando la aprobación del usuario. Esperá y volvé a consultar con check_approval.", requestId)
		case ApprovalExpired:
			app.approvals.Resolve(requestId)
			app.audit.Log(tool, env.Id, detail, "approval_expired")
			return fmt.Sprintf("La solicitud %s expiró sin respuesta. Si sigue haciendo falta, pedila de nuevo.", requestId)
		}
	}
	id := app.confirmer.Request(tool, env.Id, detail)
	if err := app.approvals.Publish(id, ApprovalRequest{Tool: tool, Env: env.Id, Class: env.Class, Detail: detail, Reason: reason}); err != nil {
		app.audit.Log(tool, env.Id, detail, "approval_publish_error: "+err.Error())
		return "ERROR: no se pudo publicar la solicitud de aprobación: " + err.Error()
	}
	app.audit.Log(tool, env.Id, detail, "human_approval_required")
	return ApprovalInstructions(id, reason, detail)
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

type RunRunbookArgs struct {
	Id           string            `json:"id" jsonschema:"id del runbook del catálogo (list_runbooks)"`
	Environment  string            `json:"environment,omitempty" jsonschema:"ambiente donde ejecutarlo (default: el del runbook o local)"`
	Params       map[string]string `json:"params,omitempty" jsonschema:"valores de los placeholders <nombre> del runbook"`
	DryRun       bool              `json:"dry_run,omitempty" jsonschema:"mostrar el comando final resuelto sin ejecutarlo"`
	ConfirmToken string            `json:"confirm_token,omitempty" jsonschema:"token devuelto por una llamada previa que requirió confirmación"`
}

type CheckApprovalArgs struct {
	Id string `json:"id" jsonschema:"id de la solicitud devuelto por una llamada que requirió aprobación humana"`
}

type LaunchAgentArgs struct {
	Id string `json:"id" jsonschema:"id del agente del catálogo (list_agents)"`
}

type NotifyArgs struct {
	Message string `json:"message" jsonschema:"texto de la notificación de escritorio"`
	Title   string `json:"title,omitempty" jsonschema:"título opcional"`
}

func main() {
	var dataDir, wshPath, envsPath, auditPath, workspace, runbooksPath, approvalsDir string
	var dev bool
	flag.StringVar(&dataDir, "data-dir", "", "data dir de la app (default: autodetectar)")
	flag.StringVar(&wshPath, "wsh", "", "ruta al binario wsh (default: autodetectar)")
	flag.StringVar(&envsPath, "environments", "", "ruta a environments.yaml (default: <configdir-guess>)")
	flag.StringVar(&auditPath, "audit", "", "ruta del log de auditoría JSONL")
	flag.StringVar(&runbooksPath, "runbooks", "", "ruta a commands.yaml (runbooks ejecutables)")
	flag.StringVar(&approvalsDir, "approvals", "", "directorio de aprobación fuera de banda; habilitado, el agente no recibe confirm_token para acciones de alto riesgo")
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

	if runbooksPath == "" {
		runbooksPath = os.Getenv("NEXUS_COMMANDS_FILE")
	}
	var runbooks *RunbookCatalog
	if runbooksPath != "" {
		runbooks, err = LoadRunbooks(runbooksPath)
		if err != nil {
			log.Fatalf("runbooks: %v", err)
		}
	}

	app := &App{
		wave:      wave,
		catalog:   catalog,
		runbooks:  runbooks,
		approvals: MakeApprovalBroker(approvalsDir),
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
		Name: "check_approval",
		Description: "Consulta si el usuario aprobó una acción que requería aprobación humana fuera de banda. " +
			"Si está aprobada, repetí la llamada original pasando este id como confirm_token.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args CheckApprovalArgs) (*mcp.CallToolResult, any, error) {
		if app.approvals == nil {
			return textResult("la aprobación fuera de banda no está habilitada en este servidor")
		}
		state, request := app.approvals.State(args.Id)
		switch state {
		case ApprovalApproved:
			return textResult(fmt.Sprintf("APROBADA. Repetí la llamada original con confirm_token=%q.", args.Id))
		case ApprovalDenied:
			return textResult("RECHAZADA por el usuario. No reintentes esta acción.")
		case ApprovalExpired:
			return textResult("EXPIRADA sin respuesta. Si sigue haciendo falta, pedila de nuevo.")
		case ApprovalPending:
			return textResult(fmt.Sprintf("PENDIENTE desde %s (expira %s): %s en %s.", request.Created, request.Expires, request.Tool, request.Env))
		}
		return textResult("no hay ninguna solicitud con ese id")
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_runbooks",
		Description: "Lista los runbooks del catálogo con los parámetros que espera cada uno y si son destructivos.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args EmptyArgs) (*mcp.CallToolResult, any, error) {
		if app.runbooks == nil || len(app.runbooks.Commands) == 0 {
			return textResult("no hay catálogo de runbooks cargado (--runbooks apuntando a commands.yaml)")
		}
		var b strings.Builder
		for _, rb := range app.runbooks.Commands {
			fmt.Fprintf(&b, "%s — %s", rb.Id, rb.Name)
			if params := RunbookParams(rb.Command); len(params) > 0 {
				fmt.Fprintf(&b, " params: %s", strings.Join(params, ", "))
			}
			if rb.Destructive {
				b.WriteString(" [DESTRUCTIVO]")
			}
			b.WriteString("\n")
		}
		return textResult(b.String())
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "run_runbook",
		Description: "Ejecuta un runbook del catálogo resolviendo sus parámetros. Con dry_run=true devuelve el comando " +
			"final sin ejecutarlo. Los runbooks destructivos, los ambientes prod/work y los contextos de producción " +
			"requieren confirmación en dos fases.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args RunRunbookArgs) (*mcp.CallToolResult, any, error) {
		if app.runbooks == nil {
			return textResult("ERROR: no hay catálogo de runbooks cargado")
		}
		rb, err := app.runbooks.Get(args.Id)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		resolved, err := ResolveRunbook(rb, args.Params)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		envId := args.Environment
		if envId == "" {
			envId = rb.Environment
		}
		env, err := app.resolveEnv(envId)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		if args.DryRun {
			app.audit.Log("run_runbook", env.Id, resolved, "dry_run")
			return textResult(fmt.Sprintf("DRY RUN — no se ejecutó nada.\nrunbook: %s (%s)\nambiente: %s (class=%s)\ncomando: %s",
				rb.Id, rb.Name, env.Id, env.Class, resolved))
		}
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		var effective EffectiveContext
		if kind := CommandContextKind(resolved); kind != "" {
			effective = app.ctxGuard.Detect(ctx, env, tabId, kind)
		}
		// un runbook marcado destructive escala aunque el comando resuelto no
		// dispare ningún patrón: el que lo escribió sabe algo que el regex no
		if msg := app.gateFull("run_runbook", env, resolved, args.ConfirmToken, effective, rb.Destructive); msg != "" {
			return textResult(msg)
		}
		out, err := app.wave.RunWsh(ctx, env.ConnName(), tabId, "run", "-c", resolved)
		if err != nil {
			app.audit.Log("run_runbook", env.Id, resolved, "error: "+err.Error())
			return textResult("ERROR: " + err.Error())
		}
		app.audit.Log("run_runbook", env.Id, resolved, "executed")
		return redactedResult(out)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_agents",
		Description: "Lista los agentes de IA del catálogo con su cadena de reemplazo por si se agota la cuota.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args EmptyArgs) (*mcp.CallToolResult, any, error) {
		if len(app.catalog.Agents) == 0 {
			return textResult("el catálogo no declara agentes")
		}
		var b strings.Builder
		for _, a := range app.catalog.Agents {
			fmt.Fprintf(&b, "%s — %s (command=%s)", a.Id, a.Name, a.Command)
			if len(a.Fallbacks) > 0 {
				fmt.Fprintf(&b, " reemplazos: %s", strings.Join(a.Fallbacks, " -> "))
			}
			b.WriteString("\n")
		}
		return textResult(b.String())
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "launch_agent",
		Description: "Lanza un agente de IA en un bloque terminal. Si el CLI reporta cuota agotada o no esta disponible, " +
			"cae automaticamente al siguiente de su cadena de reemplazo y avisa cual quedo corriendo.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args LaunchAgentArgs) (*mcp.CallToolResult, any, error) {
		chain, err := app.catalog.AgentChain(args.Id)
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		tabId, err := app.tabId()
		if err != nil {
			return textResult("ERROR: " + err.Error())
		}
		var tried []string
		for _, agent := range chain {
			env, envErr := app.resolveEnv(agent.Environment)
			if envErr != nil {
				tried = append(tried, fmt.Sprintf("%s (ambiente invalido: %v)", agent.Id, envErr))
				continue
			}
			blockId, runErr := app.wave.RunWsh(ctx, env.ConnName(), tabId, "run", "-c", agent.Command)
			if runErr != nil {
				tried = append(tried, fmt.Sprintf("%s (no arranco: %v)", agent.Id, runErr))
				app.audit.Log("launch_agent", env.Id, agent.Id, "error: "+runErr.Error())
				continue
			}
			out := app.agentStartupOutput(ctx, tabId, blockId)
			if failover, reason := ShouldFailover(out); failover {
				tried = append(tried, fmt.Sprintf("%s (%s)", agent.Id, reason))
				app.audit.Log("launch_agent", env.Id, agent.Id, "failover: "+reason)
				continue
			}
			app.audit.Log("launch_agent", env.Id, agent.Id, "executed")
			msg := fmt.Sprintf("corriendo %s (%s) en el bloque %s", agent.Name, agent.Id, strings.TrimSpace(blockId))
			if len(tried) > 0 {
				msg += "\nse descartaron antes: " + strings.Join(tried, ", ")
			}
			return textResult(msg)
		}
		return textResult("ningun agente de la cadena quedo utilizable: " + strings.Join(tried, ", "))
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
