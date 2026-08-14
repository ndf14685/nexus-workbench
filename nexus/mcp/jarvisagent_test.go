// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJarvisRegisterPayload(t *testing.T) {
	var payload map[string]any
	if err := json.Unmarshal(jarvisRegisterPayload("wb-x1"), &payload); err != nil {
		t.Fatalf("payload inválido: %v", err)
	}
	if payload["client_id"] != "wb-x1" || payload["client_type"] != "workbench" {
		t.Fatalf("identidad incorrecta: %v", payload)
	}
	caps := payload["capabilities"].([]any)
	names := map[string]string{}
	for _, c := range caps {
		m := c.(map[string]any)
		names[m["name"].(string)] = m["risk_class"].(string)
	}
	for _, required := range []string{"env.list", "terminal.create",
		"terminal.input", "terminal.read", "terminal.list",
		"terminal.set_meta", "terminal.close"} {
		if _, ok := names[required]; !ok {
			t.Fatalf("falta capability %s", required)
		}
	}
	if names["terminal.read"] != "read" || names["terminal.input"] != "reversible-write" {
		t.Fatalf("risk classes incorrectas: %v", names)
	}
}

func TestJarvisEnvListResultMapsCatalog(t *testing.T) {
	catalog := &Catalog{
		Environments: []Environment{
			{Id: "rig3060", Kind: "ssh", Host: "rig3060",
				Workspaces: []string{"~/workspace"}},
			{Id: "wsl-ubuntu", Kind: "wsl", Distro: "Ubuntu"},
		},
		Agents: []Agent{{Id: "claude", Command: "claude"}},
	}
	result := jarvisEnvListResult(catalog)
	envs := result["environments"].([]map[string]any)
	if len(envs) != 2 || envs[0]["host"] != "rig3060" {
		t.Fatalf("environments mal mapeados: %v", envs)
	}
	if envs[0]["workspaces"].([]string)[0] != "~/workspace" {
		t.Fatalf("workspaces no proyectados: %v", envs[0])
	}
}

func TestJarvisBlocksResultFiltersAndPrefixes(t *testing.T) {
	blocksJSON := `[
	  {"blockid": "abc-123", "view": "term",
	   "meta": {"connection": "rig3060", "jarvis:mission": "m-1"}},
	  {"blockid": "def-456", "view": "web", "meta": {}}
	]`
	result, err := jarvisBlocksResult(blocksJSON)
	if err != nil {
		t.Fatal(err)
	}
	blocks := result["blocks"].([]map[string]any)
	if len(blocks) != 1 {
		t.Fatalf("debe filtrar no-term: %v", blocks)
	}
	if blocks[0]["block_id"] != "block:abc-123" ||
		blocks[0]["connection"] != "rig3060" {
		t.Fatalf("mapeo incorrecto: %v", blocks[0])
	}
}

func TestJarvisCreateArgsAndParse(t *testing.T) {
	args := jarvisCreateArgs("rig3060", "~/workspace/x",
		map[string]any{"jarvis:mission": "m-1"}, "Jarvis implementer")
	joined := strings.Join(args, " ")
	for _, want := range []string{"createblock term", "controller=shell",
		"connection=rig3060", "cmd:cwd=~/workspace/x",
		"jarvis:mission=m-1", "frame:title=Jarvis implementer"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("falta %q en %q", want, joined)
		}
	}
	blockID, err := jarvisParseCreatedBlock("created block 1234-abcd\n")
	if err != nil || blockID != "block:1234-abcd" {
		t.Fatalf("parse createblock: %v %q", err, blockID)
	}
	if _, err := jarvisParseCreatedBlock("basura"); err == nil {
		t.Fatal("debe fallar sin block id")
	}
}

func TestConsumeSSEFrames(t *testing.T) {
	stream := "id: 7\nevent: capability.invoke\ndata: {\"x\":1}\n\n" +
		"id: 8\nevent: ping\ndata: {}\n\n"
	var events []string
	var lastID int64
	err := consumeSSE(strings.NewReader(stream), func(id int64, event, data string) {
		events = append(events, event)
		lastID = id
	})
	if err == nil {
		t.Fatal("EOF esperado al agotar el stream")
	}
	if len(events) != 2 || events[0] != "capability.invoke" || lastID != 8 {
		t.Fatalf("frames mal parseados: %v id=%d", events, lastID)
	}
}

func TestExecuteTerminalFlowWithFakeWsh(t *testing.T) {
	var calls [][]string
	agent := &JarvisAgent{
		catalog: &Catalog{},
		tabId:   func() (string, error) { return "tab-1", nil },
		runWsh: func(ctx context.Context, conn, tabId string, args ...string) (string, error) {
			calls = append(calls, args)
			switch args[0] {
			case "createblock":
				return "created block deadbeef", nil
			case "blocks":
				return `[{"blockid":"deadbeef","view":"term","meta":{}}]`, nil
			case "readfile":
				return "\x1b[31mhola\x1b[0m mundo\ntoken=API_KEY_SECRETO", nil
			}
			return "", nil
		},
	}
	ctx := context.Background()

	created, err := agent.execute(ctx, "terminal.create", map[string]any{
		"connection": "rig3060", "cwd": "/tmp",
		"meta": map[string]any{"jarvis:mission": "m-1"}})
	if err != nil || created["block_id"] != "block:deadbeef" {
		t.Fatalf("create: %v %v", err, created)
	}

	if _, err := agent.execute(ctx, "terminal.input", map[string]any{
		"block_id": "block:deadbeef", "data": "echo hola\n"}); err != nil {
		t.Fatalf("input: %v", err)
	}
	inputCall := calls[len(calls)-1]
	if inputCall[0] != "input" || inputCall[2] != "block:deadbeef" {
		t.Fatalf("input mal ruteado: %v", inputCall)
	}
	decoded, _ := base64.StdEncoding.DecodeString(inputCall[4])
	if string(decoded) != "echo hola\n" {
		t.Fatalf("data64 incorrecto: %q", decoded)
	}

	read, err := agent.execute(ctx, "terminal.read", map[string]any{
		"block_id": "block:deadbeef"})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	text := read["text"].(string)
	if strings.Contains(text, "\x1b[") {
		t.Fatalf("ANSI sin limpiar: %q", text)
	}
	if !strings.Contains(text, "hola mundo") {
		t.Fatalf("texto perdido: %q", text)
	}

	if _, err := agent.execute(ctx, "terminal.read", map[string]any{}); err == nil {
		t.Fatal("read sin block_id debe fallar")
	}
	if _, err := agent.execute(ctx, "nope", map[string]any{}); err == nil {
		t.Fatal("capability desconocida debe fallar")
	}
}


func TestTerminalInputDestructiveGate(t *testing.T) {
	catalog := &Catalog{Environments: []Environment{
		{Id: "prod-env", Kind: "ssh", Host: "prodhost", Class: "prod"},
		{Id: "lab-env", Kind: "ssh", Host: "labhost", Class: "lab"},
	}}
	auditPath := filepath.Join(t.TempDir(), "audit.jsonl")
	connection := "prodhost"
	inputs := 0
	agent := &JarvisAgent{
		catalog: catalog,
		audit:   MakeAuditor(auditPath),
		tabId:   func() (string, error) { return "tab-1", nil },
		runWsh: func(ctx context.Context, conn, tabId string, args ...string) (string, error) {
			switch args[0] {
			case "blocks":
				return `[{"blockid":"deadbeef","view":"term","meta":{"connection":"` + connection + `"}}]`, nil
			case "input":
				inputs++
			}
			return "", nil
		},
	}
	ctx := context.Background()

	// destructivo sobre prod: se corta antes de llegar a la terminal y queda auditado
	_, err := agent.execute(ctx, "terminal.input", map[string]any{
		"block_id": "block:deadbeef", "data": "rm -rf /var/data\n"})
	if err == nil || inputs != 0 {
		t.Fatalf("input destructivo a prod tiene que bloquearse (err=%v inputs=%d)", err, inputs)
	}
	raw, _ := os.ReadFile(auditPath)
	if !strings.Contains(string(raw), "denied_destructive_prod") {
		t.Fatalf("falta la denegación en el audit: %s", raw)
	}

	// mismo comando sobre lab: pasa (el gate duro del cerebro ya corrió antes)
	connection = "labhost"
	if _, err := agent.execute(ctx, "terminal.input", map[string]any{
		"block_id": "block:deadbeef", "data": "rm -rf /tmp/x\n"}); err != nil || inputs != 1 {
		t.Fatalf("destructivo a lab debía pasar (err=%v inputs=%d)", err, inputs)
	}

	// input normal: pasa y queda auditado como allowed
	if _, err := agent.execute(ctx, "terminal.input", map[string]any{
		"block_id": "block:deadbeef", "data": "echo hola\n"}); err != nil || inputs != 2 {
		t.Fatalf("input normal debía pasar (err=%v inputs=%d)", err, inputs)
	}
	raw, _ = os.ReadFile(auditPath)
	if !strings.Contains(string(raw), "allowed_destructive_nonprod") || !strings.Contains(string(raw), `"allowed"`) {
		t.Fatalf("audit incompleto: %s", raw)
	}
}

