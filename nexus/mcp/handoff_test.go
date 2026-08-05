// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSummarizeAuditForHandoff(t *testing.T) {
	entries := []auditEntry{
		{Ts: "t1", Tool: "run_command", Env: "lab", Detail: "kubectl get pods", Decision: "executed"},
		{Ts: "t2", Tool: "run_command", Env: "prod", Detail: "kubectl delete ns x", Decision: "human_approval_required"},
		{Ts: "t3", Tool: "open_file", Env: "lab", Detail: "/etc/hosts", Decision: "error: no such file"},
	}
	out := SummarizeAuditForHandoff(entries)
	if !strings.Contains(out, "1 esperando aprobación, 1 con error") {
		t.Fatalf("el resumen no destaca lo que quedó trabado: %s", out)
	}
	if SummarizeAuditForHandoff(nil) == "" {
		t.Fatal("sin acciones tiene que decirlo, no devolver vacío")
	}
}

// El handoff se manda a otro modelo: es el caso donde una credencial viaja más lejos.
func TestBuildHandoffRedacts(t *testing.T) {
	secret := "AKIA" + strings.Repeat("Q", 16)
	cat := &Catalog{Version: 1, Environments: []Environment{{Id: "lab", Name: "Lab", Kind: "ssh", Class: "lab"}}}
	entries := []auditEntry{{Ts: "t1", Tool: "run_command", Env: "lab", Detail: "aws configure set x " + secret, Decision: "executed"}}
	out := BuildHandoff(cat, `[{"blockid":"abc","view":"term"}]`, entries)
	if strings.Contains(out, secret) {
		t.Fatalf("la credencial sobrevivió al handoff: %s", out)
	}
}

func TestBuildHandoffCarriesTheRulesForward(t *testing.T) {
	cat := &Catalog{Version: 1, Environments: []Environment{{Id: "prod", Name: "Prod", Kind: "ssh", Class: "prod"}}}
	out := BuildHandoff(cat, "", nil)
	if !strings.Contains(out, "[REQUIERE CONFIRMACIÓN]") {
		t.Fatal("el handoff tiene que marcar los ambientes que exigen confirmación")
	}
	// el siguiente agente no puede deducir que la confirmación ya fue dada
	if !strings.Contains(out, "no la asumas dada") {
		t.Fatalf("faltan las reglas vigentes: %s", out)
	}
	if !strings.Contains(out, "(no se pudieron leer)") {
		t.Fatal("sin bloques tiene que decirlo explícitamente")
	}
}

func TestReadRecentAuditSkipsCorruptLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	os.WriteFile(path, []byte(`{"ts":"t1","tool":"a","decision":"executed"}`+"\n{roto\n"+`{"ts":"t2","tool":"b","decision":"executed"}`+"\n"), 0600)
	entries := readRecentAudit(path, 10)
	if len(entries) != 2 {
		t.Fatalf("esperaba 2 entradas válidas, hubo %d", len(entries))
	}
}

func TestReadRecentAuditKeepsTheLastOnes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString(`{"ts":"t` + string(rune('0'+i%10)) + `","tool":"x","decision":"executed"}` + "\n")
	}
	os.WriteFile(path, []byte(b.String()), 0600)
	if entries := readRecentAudit(path, 5); len(entries) != 5 {
		t.Fatalf("esperaba las últimas 5, hubo %d", len(entries))
	}
}

func TestReadRecentAuditOnMissingFile(t *testing.T) {
	if readRecentAudit(filepath.Join(t.TempDir(), "no-existe.jsonl"), 10) != nil {
		t.Fatal("un audit inexistente no puede romper el handoff")
	}
}
