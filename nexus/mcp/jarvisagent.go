// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// jarvis-agent: modo headless del binario MCP que conecta el Workbench al
// cerebro jarvisd (Jarvis Protocol v1.3). Registra las capabilities
// terminal.*/env.list y las ejecuta vía wsh sobre la app en ejecución.
// El Workbench se mantiene "tonto": cero decisiones, solo superficies.
//
//	nexus-workbench-mcp jarvis-agent --environments env.yaml \
//	    [--brain http://127.0.0.1:8770] [--client-id wb-<host>]
//
// Token: NEXUS_BRAIN_TOKEN (mismo del cerebro). Reconexión SSE con ?since=;
// re-registro en cada conexión (registro in-memory del cerebro, spec §3).
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const jarvisClientType = "workbench"

var jarvisCapabilities = []map[string]any{
	{"name": "env.list", "description": "catálogo de ambientes del Workbench",
		"risk_class": "read"},
	{"name": "terminal.list", "description": "bloques terminal con su metadata",
		"risk_class": "read"},
	{"name": "terminal.create", "description": "crear terminal (connection+cwd+meta)",
		"risk_class": "reversible-write"},
	{"name": "terminal.input", "description": "inyectar input a una terminal",
		"risk_class": "reversible-write"},
	{"name": "terminal.read", "description": "leer cola acotada de scrollback (redactada)",
		"risk_class": "read"},
	{"name": "terminal.set_meta", "description": "taggear metadata jarvis:* de un bloque",
		"risk_class": "reversible-write"},
	{"name": "terminal.close", "description": "cerrar un bloque terminal",
		"risk_class": "reversible-write"},
	{"name": "workbench.context", "description": "snapshot operativo: bloque enfocado, tarea en curso y resultado reciente",
		"risk_class": "read"},
}

// JarvisAgent es transporte puro: recibe capability.invoke por SSE, ejecuta
// vía wsh y devuelve el resultado. runWsh es inyectable para tests offline.
type JarvisAgent struct {
	brainURL  string
	token     string
	clientID  string
	workspace string
	catalog   *Catalog
	audit     *Auditor
	runWsh    func(ctx context.Context, conn string, tabId string, args ...string) (string, error)
	tabId     func() (string, error)
	httpc     *http.Client
	since     int64
}

func (ja *JarvisAgent) auditLog(tool, env, detail, decision string) {
	if ja.audit != nil {
		ja.audit.Log(tool, env, detail, decision)
	}
}

// classForBlock resuelve la clase (lab|personal|work|prod) del ambiente de la
// conexión del bloque contra el catálogo; "" sin error cuando el bloque no
// matchea ningún ambiente conocido. Error solo cuando la clasificación misma
// falla (wsh/runtime caído): el caller destructivo debe tratarlo fail-closed.
func (ja *JarvisAgent) classForBlock(ctx context.Context, blockID string) (string, error) {
	tabId, err := ja.tabId()
	if err != nil {
		return "", err
	}
	out, err := ja.runWsh(ctx, "", tabId, "blocks", "list", "--json")
	if err != nil {
		return "", err
	}
	var entries []struct {
		BlockId string         `json:"blockid"`
		Meta    map[string]any `json:"meta"`
	}
	if err := json.Unmarshal([]byte(out), &entries); err != nil {
		return "", err
	}
	want := strings.TrimPrefix(blockID, "block:")
	for _, entry := range entries {
		if entry.BlockId != want {
			continue
		}
		connection, _ := entry.Meta["connection"].(string)
		for i := range ja.catalog.Environments {
			if ja.catalog.Environments[i].ConnName() == connection {
				return ja.catalog.Environments[i].Class, nil
			}
		}
	}
	return "", nil
}

// --- payloads puros (testeables) ---

// protocolo jarvisd v1.4: register con version negociable (ADR-0006 §7)
const jarvisProtocolVersion = "1.4"

func jarvisRegisterPayload(clientID string) []byte {
	body, _ := json.Marshal(map[string]any{
		"client_id":        clientID,
		"client_type":      jarvisClientType,
		"capabilities":     jarvisCapabilities,
		"protocol_version": jarvisProtocolVersion,
		"agent_version":    ServerVersion,
	})
	return body
}

func jarvisEnvListResult(catalog *Catalog) map[string]any {
	envs := make([]map[string]any, 0, len(catalog.Environments))
	for _, e := range catalog.Environments {
		envs = append(envs, map[string]any{
			"id": e.Id, "kind": e.Kind, "host": e.Host, "distro": e.Distro,
			"class": e.Class, "workspaces": e.Workspaces,
		})
	}
	agents := make([]string, 0, len(catalog.Agents))
	for _, a := range catalog.Agents {
		agents = append(agents, a.Id)
	}
	return map[string]any{"environments": envs, "agents": agents}
}

// Claves de meta donde vive la tarea de un bloque. Se eligio meta EXPLICITA y
// no inferencia sobre stdout: quien lanza la tarea la escribe, y el snapshot
// solo lee. Inferir el prompt parseando scrollback es fragil ante TUIs,
// colores y agentes distintos, y ya hay precedente de que sale mal.
const (
	metaTaskInstruction = "jarvis:task:instruction"
	metaTaskStatus      = "jarvis:task:status"
	metaTaskStartedAt   = "jarvis:task:started_at"
	metaTaskCompletedAt = "jarvis:task:completed_at"
	metaTaskAgent       = "jarvis:task:agent"
	metaTaskResult      = "jarvis:task:result_summary"
	metaMission         = "jarvis:mission"
)

func metaString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, _ := meta[key].(string)
	return strings.TrimSpace(value)
}

func metaNumber(meta map[string]any, key string) (float64, bool) {
	if meta == nil {
		return 0, false
	}
	switch v := meta[key].(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// jarvisTaskFromMeta arma el sub-objeto `task` de un bloque, o nil si el bloque
// no tiene tarea registrada. Sin instruccion no hay tarea: un bloque con solo
// status es ruido, no contexto.
func jarvisTaskFromMeta(meta map[string]any) map[string]any {
	instruction := metaString(meta, metaTaskInstruction)
	if instruction == "" {
		return nil
	}
	task := map[string]any{
		"instruction": instruction,
		"status":      metaString(meta, metaTaskStatus),
	}
	if agent := metaString(meta, metaTaskAgent); agent != "" {
		task["agent"] = agent
	}
	if mission := metaString(meta, metaMission); mission != "" {
		task["mission"] = mission
	}
	if started, ok := metaNumber(meta, metaTaskStartedAt); ok {
		task["started_at"] = started
	}
	if completed, ok := metaNumber(meta, metaTaskCompletedAt); ok {
		task["completed_at"] = completed
	}
	// El resumen viaja; la salida cruda NO. El cerebro pide detalle con
	// terminal.read sobre raw_output_ref si de verdad lo necesita (ADR: no
	// mandar 20k tokens de scrollback a cada resolucion de deixis).
	if summary := metaString(meta, metaTaskResult); summary != "" {
		task["result_summary"] = summary
	}
	return task
}

// jarvisContextResult arma el snapshot operativo del Workbench: que bloque esta
// enfocado, que tarea tiene, y que hay alrededor.
//
// Existe porque el contexto rico del Workbench vivia SOLO en el renderer
// (captureFocusedContext en frontend/app/nexus/jarvis/context.ts) y viajaba
// unicamente cuando el dueno escribia en el overlay. Por voz, el cerebro
// entraba por GET /workbench/context, que devuelve una lista de cwd sin foco,
// sin ultimo comando y sin tarea: de ahi el "no tengo en el contexto cuales son
// esos 3 items". Este snapshot es el mismo dato, por el canal que TODAS las
// superficies comparten.
func jarvisContextResult(blocksJSON string, tabID string) (map[string]any, error) {
	var entries []struct {
		BlockId     string         `json:"blockid"`
		WorkspaceId string         `json:"workspaceid"`
		TabId       string         `json:"tabid"`
		View        string         `json:"view"`
		Focused     bool           `json:"focused"`
		Meta        map[string]any `json:"meta"`
	}
	if err := json.Unmarshal([]byte(blocksJSON), &entries); err != nil {
		return nil, fmt.Errorf("parseando blocks list: %w", err)
	}

	blocks := make([]map[string]any, 0, len(entries))
	var focused map[string]any
	workspaceID := ""

	for _, e := range entries {
		// Solo el tab activo: los bloques de otros tabs no son "lo que tenes
		// delante", y meterlos convertiria el snapshot en un inventario.
		if tabID != "" && e.TabId != "" && e.TabId != tabID {
			continue
		}
		if workspaceID == "" {
			workspaceID = e.WorkspaceId
		}
		view := e.View
		if view == "" {
			view = metaString(e.Meta, "view")
		}
		block := map[string]any{
			"block_id":   "block:" + e.BlockId,
			"view":       view,
			"focused":    e.Focused,
			"connection": metaString(e.Meta, "connection"),
		}
		if cwd := metaString(e.Meta, "cmd:cwd"); cwd != "" {
			block["cwd"] = cwd
		}
		if controller := metaString(e.Meta, "controller"); controller != "" {
			block["controller"] = controller
		}
		title := metaString(e.Meta, "frame:title")
		if title == "" {
			title = metaString(e.Meta, "nexus:web:title")
		}
		if title != "" {
			block["title"] = title
		}
		if url := metaString(e.Meta, "url"); url != "" {
			block["url"] = url
		}
		if task := jarvisTaskFromMeta(e.Meta); task != nil {
			block["task"] = task
		}
		blocks = append(blocks, block)
		if e.Focused {
			focused = block
		}
	}

	out := map[string]any{
		"workspace_id": workspaceID,
		"tab_id":       tabID,
		"blocks":       blocks,
		// focused_block_available deja que el health (y el resolver) distingan
		// "no hay foco" de "no pude leerlo": son dos fallas distintas y una es
		// normal (ningun bloque enfocado) y la otra no.
		"focused_block_available": focused != nil,
	}
	if focused != nil {
		out["focused_block"] = focused
	}
	return out, nil
}

// jarvisBlocksResult adapta la salida de `wsh blocks list --json` al contrato
// terminal.list del cerebro ({blocks: [{block_id, meta, connection}]}).
func jarvisBlocksResult(blocksJSON string) (map[string]any, error) {
	var entries []struct {
		BlockId string         `json:"blockid"`
		View    string         `json:"view"`
		Meta    map[string]any `json:"meta"`
	}
	if err := json.Unmarshal([]byte(blocksJSON), &entries); err != nil {
		return nil, fmt.Errorf("parseando blocks list: %w", err)
	}
	blocks := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		if e.View != "" && e.View != "term" {
			continue
		}
		connection, _ := e.Meta["connection"].(string)
		blocks = append(blocks, map[string]any{
			"block_id":   "block:" + e.BlockId,
			"meta":       e.Meta,
			"connection": connection,
		})
	}
	return map[string]any{"blocks": blocks}, nil
}

// jarvisCreateArgs arma los argumentos de `wsh createblock` para una terminal
// con conexión/cwd/meta de misión. El host de ejecución REAL queda en el meta
// `connection` del bloque: una terminal SSH nunca es ejecución local.
func jarvisCreateArgs(connection, cwd string, meta map[string]any, title string) []string {
	args := []string{"createblock", "term", "controller=shell"}
	if connection != "" {
		args = append(args, "connection="+connection)
	}
	if cwd != "" {
		args = append(args, "cmd:cwd="+cwd)
	}
	if title != "" {
		args = append(args, "frame:title="+title)
	}
	// ADR-0006 §4/§5: toda sesión de misión lleva ownership; las remotas además
	// corren bajo jobmanager durable y sobreviven restarts del runtime.
	if _, ok := meta["nexus:owner"]; !ok {
		args = append(args, "nexus:owner=mission")
	}
	if _, ok := meta["term:durable"]; !ok && connection != "" {
		args = append(args, "term:durable=true")
	}
	for key, value := range meta {
		args = append(args, fmt.Sprintf("%s=%v", key, value))
	}
	return args
}

func jarvisParseCreatedBlock(out string) (string, error) {
	// `wsh createblock` imprime "created block <oid>"
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, "created block "); ok {
			return "block:" + strings.TrimSpace(rest), nil
		}
	}
	return "", fmt.Errorf("createblock sin block id en la salida: %q", out)
}

// --- ejecución de capabilities ---

func (ja *JarvisAgent) execute(ctx context.Context, capability string, args map[string]any) (map[string]any, error) {
	str := func(key string) string {
		value, _ := args[key].(string)
		return value
	}
	switch capability {
	case "env.list":
		return jarvisEnvListResult(ja.catalog), nil
	case "terminal.list":
		tabId, err := ja.tabId()
		if err != nil {
			return nil, err
		}
		out, err := ja.runWsh(ctx, "", tabId, "blocks", "list", "--json")
		if err != nil {
			return nil, err
		}
		return jarvisBlocksResult(out)
	case "workbench.context":
		tabId, err := ja.tabId()
		if err != nil {
			return nil, err
		}
		out, err := ja.runWsh(ctx, "", tabId, "blocks", "list", "--json")
		if err != nil {
			return nil, err
		}
		return jarvisContextResult(out, tabId)
	case "terminal.create":
		tabId, err := ja.tabId()
		if err != nil {
			return nil, err
		}
		meta, _ := args["meta"].(map[string]any)
		ja.auditLog("jarvis:terminal.create", "",
			fmt.Sprintf("connection=%s cwd=%s", str("connection"), str("cwd")), "allowed")
		// sin la conexión establecida el bloque queda creado pero su controller
		// nunca arranca (CheckConnStatus falla en el resync)
		if conn := str("connection"); conn != "" {
			if _, err := ja.runWsh(ctx, "", tabId, "conn", "connect", conn); ignoreAlreadyConnected(err) != nil {
				return nil, fmt.Errorf("conectando %s: %w", conn, err)
			}
		}
		wshArgs := jarvisCreateArgs(str("connection"), str("cwd"), meta, str("title"))
		out, err := ja.runWsh(ctx, str("connection"), tabId, wshArgs...)
		if err != nil {
			return nil, err
		}
		blockID, err := jarvisParseCreatedBlock(out)
		if err != nil {
			return nil, err
		}
		// el frontend solo arranca controllers de bloques que renderiza; con
		// la UI cerrada o el bloque parkeado (headless) nadie lo haría y el
		// primer terminal.input fallaría con "no controller found"
		if _, err := ja.runWsh(ctx, "", tabId, "block", "start", blockID); err != nil {
			return nil, fmt.Errorf("arrancando controller de %s: %w", blockID, err)
		}
		if headless, _ := args["headless"].(bool); headless {
			note := "mission"
			if mission, ok := meta["jarvis:mission"].(string); ok && mission != "" {
				note = "mission " + mission
			}
			// si el park falla el bloque queda visible pero la misión sigue
			if _, err := ja.runWsh(ctx, "", tabId, "block", "park", blockID,
				"--note", note); err != nil {
				log.Printf("park headless de %s falló: %v", blockID, err)
			}
		}
		return map[string]any{"block_id": blockID}, nil
	case "terminal.input":
		blockID := str("block_id")
		if blockID == "" {
			return nil, fmt.Errorf("block_id requerido")
		}
		// ADR-0004 §2: este camino de escritura también pasa por policy. El
		// InstructionGuard del cerebro es la primera línea; acá el Workbench
		// corta en seco lo destructivo sobre ambientes prod y audita todo.
		data := str("data")
		if IsDestructive(data) {
			class, err := ja.classForBlock(ctx, blockID)
			if err != nil {
				ja.auditLog("jarvis:terminal.input", "", data, "denied_destructive_unknown_env")
				return nil, fmt.Errorf("input destructivo bloqueado: no se pudo clasificar "+
					"el ambiente (fail-closed, gobernanza ADR-0004): %w", err)
			}
			if class == "prod" {
				ja.auditLog("jarvis:terminal.input", class, data, "denied_destructive_prod")
				return nil, fmt.Errorf("input destructivo bloqueado en ambiente prod " +
					"(gobernanza ADR-0004): requiere aprobación humana")
			}
			ja.auditLog("jarvis:terminal.input", class, data, "allowed_destructive_nonprod")
		} else {
			ja.auditLog("jarvis:terminal.input", "", "block="+blockID, "allowed")
		}
		tabId, err := ja.tabId()
		if err != nil {
			return nil, err
		}
		data64 := base64.StdEncoding.EncodeToString([]byte(data))
		if _, err := ja.runWsh(ctx, "", tabId, "input", "-b", blockID,
			"--data64", data64); err != nil {
			return nil, err
		}
		return map[string]any{"accepted": true}, nil
	case "terminal.read":
		blockID := str("block_id")
		if blockID == "" {
			return nil, fmt.Errorf("block_id requerido")
		}
		tabId, err := ja.tabId()
		if err != nil {
			return nil, err
		}
		out, err := ja.runWsh(ctx, "", tabId, "readfile", "term", "-b", blockID)
		if err != nil {
			return nil, err
		}
		tail := 200
		if n, ok := args["tail_lines"].(float64); ok && n > 0 {
			tail = int(n)
		}
		// stripAnsi + tail acotado + redacción: al cerebro nunca viajan
		// secretos ni scrollback ilimitado.
		text := RedactForAgent(tailLines(stripAnsi(out), tail))
		return map[string]any{"text": text, "shell_state": "",
			"last_exit_code": nil}, nil
	case "terminal.set_meta":
		blockID := str("block_id")
		meta, _ := args["meta"].(map[string]any)
		if blockID == "" || len(meta) == 0 {
			return nil, fmt.Errorf("block_id y meta requeridos")
		}
		tabId, err := ja.tabId()
		if err != nil {
			return nil, err
		}
		ja.auditLog("jarvis:terminal.set_meta", "", "block="+blockID, "allowed")
		setArgs := []string{"setmeta", "-b", blockID}
		for key, value := range meta {
			setArgs = append(setArgs, fmt.Sprintf("%s=%v", key, value))
		}
		// camino ADOPT (ADR-0006 §4): taggear jarvis:mission transfiere ownership
		if _, adopt := meta["jarvis:mission"]; adopt {
			if _, ok := meta["nexus:owner"]; !ok {
				setArgs = append(setArgs, "nexus:owner=mission")
			}
		}
		if _, err := ja.runWsh(ctx, "", tabId, setArgs...); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "terminal.close":
		blockID := str("block_id")
		if blockID == "" {
			return nil, fmt.Errorf("block_id requerido")
		}
		tabId, err := ja.tabId()
		if err != nil {
			return nil, err
		}
		ja.auditLog("jarvis:terminal.close", "", "block="+blockID, "allowed")
		if _, err := ja.runWsh(ctx, "", tabId, "deleteblock", "-b", blockID); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	}
	return nil, fmt.Errorf("capability desconocida: %s", capability)
}

// --- protocolo (register + SSE + results) ---

func (ja *JarvisAgent) request(method, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequest(method, ja.brainURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if ja.token != "" {
		req.Header.Set("Authorization", "Bearer "+ja.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := ja.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return data, fmt.Errorf("%s %s -> %d: %s", method, path, resp.StatusCode, data)
	}
	return data, nil
}

func (ja *JarvisAgent) register() error {
	_, err := ja.request(http.MethodPost, "/clients/register",
		jarvisRegisterPayload(ja.clientID))
	return err
}

// consumeSSE lee frames id/event/data separados por línea en blanco y los
// entrega al handler. Retorna al cerrarse el stream (el caller reconecta).
func consumeSSE(r io.Reader, handle func(id int64, event, data string)) error {
	reader := bufio.NewReader(r)
	frame := map[string]string{}
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			line = strings.TrimRight(line, "\n")
			if line == "" {
				if len(frame) > 0 {
					id, _ := strconv.ParseInt(frame["id"], 10, 64)
					handle(id, frame["event"], frame["data"])
					frame = map[string]string{}
				}
			} else if key, value, ok := strings.Cut(line, ": "); ok {
				frame[key] = value
			}
		}
		if err != nil {
			return err
		}
	}
}

func (ja *JarvisAgent) streamOnce(ctx context.Context) error {
	// Primera conexión: sin ?since= (live-only). Replayear el ring re-ejecutaría
	// capability.invoke viejos de una vida anterior del agente; el broker
	// rechaza el resultado tardío pero el efecto lateral ocurriría igual.
	url := fmt.Sprintf("%s/events?client=%s", ja.brainURL, ja.clientID)
	if ja.since > 0 {
		url = fmt.Sprintf("%s&since=%d", url, ja.since)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if ja.token != "" {
		req.Header.Set("Authorization", "Bearer "+ja.token)
	}
	resp, err := (&http.Client{Timeout: 0}).Do(req) // stream de larga vida
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("stream %d: %s", resp.StatusCode, body)
	}
	return consumeSSE(resp.Body, func(id int64, event, data string) {
		if id > ja.since {
			ja.since = id
		}
		if event != "capability.invoke" {
			return
		}
		go ja.handleInvoke(ctx, data)
	})
}

func (ja *JarvisAgent) handleInvoke(ctx context.Context, data string) {
	var invoke struct {
		InvocationId string         `json:"invocation_id"`
		Capability   string         `json:"capability"`
		Args         map[string]any `json:"args"`
	}
	if err := json.Unmarshal([]byte(data), &invoke); err != nil {
		log.Printf("capability.invoke inválido: %v", err)
		return
	}
	payload := map[string]any{"invocation_id": invoke.InvocationId}
	result, err := ja.execute(ctx, invoke.Capability, invoke.Args)
	if err != nil {
		payload["ok"] = false
		payload["error"] = err.Error()
		log.Printf("capability %s falló: %v", invoke.Capability, err)
	} else {
		payload["ok"] = true
		payload["result"] = result
	}
	body, _ := json.Marshal(payload)
	if _, err := ja.request(http.MethodPost, "/capability/result", body); err != nil {
		log.Printf("no pude entregar el resultado de %s: %v", invoke.Capability, err)
	}
}

func (ja *JarvisAgent) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := ja.register(); err != nil {
			log.Printf("registro contra el cerebro falló: %v (reintento en %s)", err, backoff)
		} else {
			log.Printf("registrado como %s contra %s; escuchando SSE", ja.clientID, ja.brainURL)
			backoff = time.Second
			if err := ja.streamOnce(ctx); err != nil && ctx.Err() == nil {
				log.Printf("stream cerrado: %v; reconecto con since=%d", err, ja.since)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// --- entrypoint del subcomando ---

func runJarvisAgent(argv []string) {
	flags := flag.NewFlagSet("jarvis-agent", flag.ExitOnError)
	var dataDir, wshPath, envsPath, brainURL, clientID, workspace string
	var dev bool
	flags.StringVar(&dataDir, "data-dir", "", "data dir de la app (default: autodetectar)")
	flags.StringVar(&wshPath, "wsh", "", "ruta al binario wsh (default: autodetectar)")
	flags.StringVar(&envsPath, "environments", "", "ruta a environments.yaml")
	flags.StringVar(&brainURL, "brain", "", "URL del cerebro (default: JARVIS_BRAIN_URL o http://127.0.0.1:8770)")
	flags.StringVar(&clientID, "client-id", "", "client_id del protocolo (default: wb-<hostname>)")
	flags.StringVar(&workspace, "workspace", "", "workspace destino (default: primero activo)")
	flags.BoolVar(&dev, "dev", false, "usar los directorios waveterm-dev")
	_ = flags.Parse(argv)

	log.SetOutput(os.Stderr)
	if brainURL == "" {
		brainURL = os.Getenv("JARVIS_BRAIN_URL")
	}
	if brainURL == "" {
		brainURL = "http://127.0.0.1:8770"
	}
	if clientID == "" {
		host, _ := os.Hostname()
		if host == "" {
			host = "desktop"
		}
		clientID = "wb-" + host
	}
	if envsPath == "" {
		envsPath = os.Getenv("NEXUS_ENVIRONMENTS_FILE")
	}
	catalog := &Catalog{}
	if envsPath != "" {
		loaded, err := LoadCatalog(envsPath)
		if err != nil {
			log.Fatalf("catálogo: %v", err)
		}
		catalog = loaded
	} else {
		log.Printf("sin --environments: env.list devolverá catálogo vacío")
	}
	resolvedWsh, err := ResolveWshPath(wshPath)
	if err != nil {
		log.Fatalf("wsh: %v", err)
	}
	wave, err := MakeWaveAccess(ResolveDataDir(dataDir, dev), resolvedWsh)
	if err != nil {
		log.Fatalf("no puedo acceder al motor: %v", err)
	}
	agent := &JarvisAgent{
		brainURL:  strings.TrimRight(brainURL, "/"),
		token:     strings.TrimSpace(os.Getenv("NEXUS_BRAIN_TOKEN")),
		clientID:  clientID,
		workspace: workspace,
		catalog:   catalog,
		audit:     MakeAuditor(filepath.Join(ResolveDataDir(dataDir, dev), "nexus-mcp-audit.jsonl")),
		runWsh:    wave.RunWsh,
		tabId:     func() (string, error) { return wave.ActiveTabId(workspace) },
		httpc:     &http.Client{Timeout: 15 * time.Second},
	}
	agent.Run(context.Background())
}
