// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

// blocksJSON arma la salida de `wsh blocks list --json` para los tests.
const contextBlocksJSON = `[
  {"blockid":"aaa","workspaceid":"ws1","tabid":"tab1","view":"term",
   "meta":{"cmd:cwd":"D:/ndf14/workspace/repo-a","controller":"shell","frame:title":"A"}},
  {"blockid":"bbb","workspaceid":"ws1","tabid":"tab1","view":"term","focused":true,
   "meta":{"cmd:cwd":"D:/ndf14/workspace/repo-b","controller":"shell","frame:title":"B",
           "jarvis:task:instruction":"resolver tres cosas: 1 PowerShell 2 Media Sender 3 Yoshi",
           "jarvis:task:status":"completed","jarvis:task:agent":"claude-code",
           "jarvis:task:started_at":1787000000,"jarvis:task:completed_at":"1787000900",
           "jarvis:task:result_summary":"los tres puntos quedaron cerrados"}},
  {"blockid":"ccc","workspaceid":"ws1","tabid":"OTRO","view":"term",
   "meta":{"cmd:cwd":"D:/ndf14/workspace/otro-tab"}},
  {"blockid":"ddd","workspaceid":"ws1","tabid":"tab1","view":"web",
   "meta":{"url":"https://x.dev/p","nexus:web:title":"Doc"}}
]`

func TestWorkbenchContextCapabilityDeclared(t *testing.T) {
	found := false
	for _, cap := range jarvisCapabilities {
		if cap["name"] == "workbench.context" {
			found = true
			if cap["risk_class"] != "read" {
				t.Errorf("workbench.context deberia ser read, es %v", cap["risk_class"])
			}
		}
	}
	if !found {
		t.Fatal("workbench.context no esta declarada en jarvisCapabilities")
	}
}

func TestJarvisContextResultFocusAndTask(t *testing.T) {
	out, err := jarvisContextResult(contextBlocksJSON, "tab1")
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}

	if out["workspace_id"] != "ws1" {
		t.Errorf("workspace_id = %v, quiero ws1", out["workspace_id"])
	}
	if out["focused_block_available"] != true {
		t.Fatal("focused_block_available deberia ser true")
	}

	// Los bloques de OTRO tab no son "lo que tenes delante".
	blocks, _ := out["blocks"].([]map[string]any)
	if len(blocks) != 3 {
		t.Fatalf("quiero 3 bloques del tab activo, hay %d", len(blocks))
	}
	for _, b := range blocks {
		if strings.Contains(b["block_id"].(string), "ccc") {
			t.Error("un bloque de otro tab se filtro al snapshot")
		}
	}

	focused, ok := out["focused_block"].(map[string]any)
	if !ok {
		t.Fatal("falta focused_block")
	}
	if focused["block_id"] != "block:bbb" {
		t.Fatalf("focused_block = %v, quiero block:bbb", focused["block_id"])
	}
	if focused["cwd"] != "D:/ndf14/workspace/repo-b" {
		t.Errorf("cwd del focused = %v", focused["cwd"])
	}

	task, ok := focused["task"].(map[string]any)
	if !ok {
		t.Fatal("el bloque enfocado deberia traer task")
	}
	// El caso real: "los tres puntos" tiene que ser resoluble desde aca.
	if !strings.Contains(task["instruction"].(string), "PowerShell") {
		t.Errorf("instruction no trae los items: %v", task["instruction"])
	}
	if task["status"] != "completed" {
		t.Errorf("status = %v", task["status"])
	}
	if task["agent"] != "claude-code" {
		t.Errorf("agent = %v", task["agent"])
	}
	if task["result_summary"] != "los tres puntos quedaron cerrados" {
		t.Errorf("result_summary = %v", task["result_summary"])
	}
	// started_at numerico y completed_at como string: los dos deben normalizar.
	if got, _ := task["started_at"].(float64); got != 1787000000 {
		t.Errorf("started_at = %v", task["started_at"])
	}
	if got, _ := task["completed_at"].(float64); got != 1787000900 {
		t.Errorf("completed_at = %v", task["completed_at"])
	}
}

// Caso B de la especificacion: varias terminales, el foco decide.
func TestJarvisContextResultFocusWins(t *testing.T) {
	four := `[
	  {"blockid":"A","workspaceid":"w","tabid":"t","view":"term","meta":{"cmd:cwd":"/a"}},
	  {"blockid":"B","workspaceid":"w","tabid":"t","view":"term","meta":{"cmd:cwd":"/b"}},
	  {"blockid":"C","workspaceid":"w","tabid":"t","view":"term","focused":true,"meta":{"cmd:cwd":"/c"}},
	  {"blockid":"D","workspaceid":"w","tabid":"t","view":"term","meta":{"cmd:cwd":"/d"}}
	]`
	out, err := jarvisContextResult(four, "t")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	focused := out["focused_block"].(map[string]any)
	if focused["block_id"] != "block:C" {
		t.Fatalf("con foco en C el snapshot eligio %v", focused["block_id"])
	}
	if focused["cwd"] != "/c" {
		t.Fatalf("cwd = %v, quiero /c", focused["cwd"])
	}
}

func TestJarvisContextResultNoFocus(t *testing.T) {
	out, err := jarvisContextResult(
		`[{"blockid":"x","workspaceid":"w","tabid":"t","view":"term","meta":{"cmd:cwd":"/x"}}]`, "t")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if out["focused_block_available"] != false {
		t.Error("sin foco, focused_block_available deberia ser false")
	}
	if _, present := out["focused_block"]; present {
		t.Error("sin foco no deberia haber focused_block")
	}
}

func TestJarvisTaskFromMetaNeedsInstruction(t *testing.T) {
	// status sin instruccion no es una tarea: es ruido.
	if task := jarvisTaskFromMeta(map[string]any{metaTaskStatus: "running"}); task != nil {
		t.Errorf("sin instruction no deberia haber task, hay %v", task)
	}
	if task := jarvisTaskFromMeta(nil); task != nil {
		t.Error("meta nil no deberia producir task")
	}
	task := jarvisTaskFromMeta(map[string]any{metaTaskInstruction: "  hacer X  "})
	if task == nil || task["instruction"] != "hacer X" {
		t.Errorf("instruction deberia venir trimmeada, task = %v", task)
	}
}

func TestJarvisContextResultBadJSON(t *testing.T) {
	if _, err := jarvisContextResult("no-json", "t"); err == nil {
		t.Fatal("json invalido deberia dar error")
	}
}

// El flujo real: sesion de agente lanzada a mano, prompt tipeado en la TUI.
// La metadata no tiene instruccion, pero SI agente y scrollback.
func TestJarvisTaskFromMetaTuiSession(t *testing.T) {
	task := jarvisTaskFromMeta(map[string]any{
		metaTaskAgent:     "claude-code",
		metaTaskRawOutput: "block:tui",
		metaTaskStatus:    "completed",
	})
	if task == nil {
		t.Fatal("una sesion de agente sin instruccion sigue siendo una tarea")
	}
	if task["instruction"] != "" {
		t.Errorf("instruction deberia venir vacia, es %v", task["instruction"])
	}
	if task["raw_output_ref"] != "block:tui" {
		t.Errorf("falta raw_output_ref, hay %v", task["raw_output_ref"])
	}
	if task["agent"] != "claude-code" {
		t.Errorf("agent = %v", task["agent"])
	}
}

func TestJarvisTaskFromMetaNeedsAgentAndRef(t *testing.T) {
	// Solo agente, sin donde leer: no alcanza.
	if task := jarvisTaskFromMeta(map[string]any{metaTaskAgent: "claude-code"}); task != nil {
		t.Errorf("sin raw_output_ref no deberia haber task, hay %v", task)
	}
	// Solo referencia, sin agente: tampoco.
	if task := jarvisTaskFromMeta(map[string]any{metaTaskRawOutput: "block:x"}); task != nil {
		t.Errorf("sin agente no deberia haber task, hay %v", task)
	}
}
