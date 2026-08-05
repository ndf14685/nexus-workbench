// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// La redacción genérica tapa cualquier "token: <valor>". El confirm_token es un
// control de seguridad que el agente necesita intacto para poder confirmar, así
// que el mensaje del gate NO puede pasar por el redactor.
func TestGateMessageKeepsConfirmToken(t *testing.T) {
	app := &App{confirmer: MakeConfirmer(), audit: MakeAuditor(filepath.Join(t.TempDir(), "audit.jsonl"))}
	env := &Environment{Id: "prod-k8s", Name: "Prod", Kind: "ssh", Class: "prod", Criticality: "high"}

	msg := app.gate("run_command", env, "kubectl delete ns staging", "")
	if msg == "" {
		t.Fatal("un ambiente prod tiene que exigir confirmación")
	}
	token := regexp.MustCompile(`confirm_token="([0-9a-f]{16})"`).FindStringSubmatch(msg)
	if token == nil {
		t.Fatalf("el mensaje del gate no expone un confirm_token usable: %s", msg)
	}
	if strings.Contains(msg, RedactedMarker) {
		t.Fatalf("el gate redactó su propio token: %s", msg)
	}
	if out := app.gate("run_command", env, "kubectl delete ns staging", token[1]); out != "" {
		t.Fatalf("el token devuelto no confirmó la acción: %s", out)
	}
}

func TestAuditRedactsSecretsInDetail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	pat := "ghp_" + strings.Repeat("z", 36)
	MakeAuditor(path).Log("run_command", "prod", "export GITHUB_TOKEN="+pat, "executed")

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), pat) {
		t.Fatalf("el secreto quedó escrito en el audit: %s", raw)
	}
	var rec map[string]any
	if err := json.Unmarshal(raw[:len(raw)-1], &rec); err != nil {
		t.Fatalf("el audit dejó de ser JSONL válido: %v", err)
	}
	if rec["redacted"] == nil {
		t.Fatal("el registro no marca que hubo redacción")
	}
	if !strings.Contains(rec["detail"].(string), "GITHUB_TOKEN") {
		t.Fatalf("se perdió el nombre de la variable en el audit: %v", rec["detail"])
	}
}

func TestAuditKeepsOrdinaryCommandIntact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	MakeAuditor(path).Log("run_command", "lab", "kubectl get pods -n nexus", "executed")

	raw, _ := os.ReadFile(path)
	var rec map[string]any
	json.Unmarshal(raw[:len(raw)-1], &rec)
	if rec["detail"] != "kubectl get pods -n nexus" {
		t.Fatalf("se alteró un comando sin secretos: %v", rec["detail"])
	}
	if rec["redacted"] != nil {
		t.Fatalf("marcó redacción donde no había secretos: %v", rec)
	}
}

// El accidente que esto evita: el catálogo dice lab, el kubeconfig dice prod.
func TestGateEscalatesWhenEffectiveContextIsProduction(t *testing.T) {
	app := &App{confirmer: MakeConfirmer(), audit: MakeAuditor(filepath.Join(t.TempDir(), "audit.jsonl"))}
	lab := &Environment{Id: "rig3060", Name: "rig", Kind: "ssh", Class: "lab", Criticality: "low"}

	if msg := app.gate("run_command", lab, "kubectl get pods", ""); msg != "" {
		t.Fatalf("un comando inocuo en lab no debería pedir confirmación: %s", msg)
	}

	prodCtx := EffectiveContext{Kind: "kubernetes", Name: "prod-eks", Available: true}
	msg := app.gateWithContext("run_command", lab, "kubectl get pods", "", prodCtx)
	if msg == "" {
		t.Fatal("un contexto de producción tiene que exigir confirmación aunque el ambiente sea lab")
	}
	if !strings.Contains(msg, "prod-eks") {
		t.Fatalf("el mensaje tiene que decir CUÁL es el contexto peligroso: %s", msg)
	}
}

// Si el probe no pudo determinar el contexto no inventamos una escalada.
func TestGateDoesNotEscalateOnUnknownContext(t *testing.T) {
	app := &App{confirmer: MakeConfirmer(), audit: MakeAuditor(filepath.Join(t.TempDir(), "audit.jsonl"))}
	lab := &Environment{Id: "rig3060", Kind: "ssh", Class: "lab", Criticality: "low"}
	unknown := EffectiveContext{Kind: "kubernetes", Name: "prod-eks", Available: false}
	if msg := app.gateWithContext("run_command", lab, "kubectl get pods", "", unknown); msg != "" {
		t.Fatalf("un contexto indeterminado no debería escalar: %s", msg)
	}
}
