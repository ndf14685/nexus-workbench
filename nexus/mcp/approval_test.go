// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func broker(t *testing.T) *ApprovalBroker {
	t.Helper()
	return MakeApprovalBroker(t.TempDir())
}

func publish(t *testing.T, b *ApprovalBroker, id string) {
	t.Helper()
	err := b.Publish(id, ApprovalRequest{Tool: "run_command", Env: "prod-k8s", Class: "prod", Detail: "kubectl delete ns staging", Reason: "ambiente prod"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestApprovalStartsPending(t *testing.T) {
	b := broker(t)
	publish(t, b, "00112233aabbccdd")
	state, req := b.State("00112233aabbccdd")
	if state != ApprovalPending {
		t.Fatalf("estado = %s", state)
	}
	if req.Env != "prod-k8s" || req.Detail != "kubectl delete ns staging" {
		t.Fatalf("solicitud mal serializada: %+v", req)
	}
}

func TestApprovalBecomesApproved(t *testing.T) {
	b := broker(t)
	id := "00112233aabbccdd"
	publish(t, b, id)
	os.WriteFile(filepath.Join(b.dir, id+".approved"), []byte("ndf via telegram\n"), 0600)
	if state, _ := b.State(id); state != ApprovalApproved {
		t.Fatalf("estado = %s", state)
	}
}

// Si llegaron las dos marcas, la respuesta segura es no.
func TestDenialWinsOverApproval(t *testing.T) {
	b := broker(t)
	id := "00112233aabbccdd"
	publish(t, b, id)
	os.WriteFile(filepath.Join(b.dir, id+".approved"), nil, 0600)
	os.WriteFile(filepath.Join(b.dir, id+".denied"), nil, 0600)
	if state, _ := b.State(id); state != ApprovalDenied {
		t.Fatalf("estado = %s, la denegación tiene que ganar", state)
	}
}

func TestUnknownApprovalId(t *testing.T) {
	if state, _ := broker(t).State("ffffffffffffffff"); state != ApprovalUnknown {
		t.Fatalf("estado = %s", state)
	}
}

// El id viaja desde afuera y se usa para construir una ruta.
func TestApprovalRejectsPathTraversal(t *testing.T) {
	b := broker(t)
	for _, id := range []string{"../../etc/passwd", "aa/bb", "", "ZZZZ", strings.Repeat("a", 64), "00112233aabbccd"} {
		if state, _ := b.State(id); state != ApprovalUnknown {
			t.Errorf("id %q no fue rechazado (estado %s)", id, state)
		}
		if err := b.Publish(id, ApprovalRequest{}); err == nil {
			t.Errorf("Publish aceptó el id %q", id)
		}
	}
}

// La solicitud la lee una persona por un canal externo: un secreto en el
// comando no puede viajar en un mensaje de Telegram.
func TestPublishRedactsDetail(t *testing.T) {
	b := broker(t)
	id := "00112233aabbccdd"
	secret := "AKIA" + strings.Repeat("Q", 16)
	b.Publish(id, ApprovalRequest{Tool: "run_command", Env: "prod", Detail: "aws configure set aws_access_key_id " + secret})
	raw, _ := os.ReadFile(filepath.Join(b.dir, id+".json"))
	if strings.Contains(string(raw), secret) {
		t.Fatalf("la credencial quedó en la solicitud: %s", raw)
	}
}

// Una aprobación consumida no puede habilitar una segunda ejecución.
func TestResolveClearsMarkers(t *testing.T) {
	b := broker(t)
	id := "00112233aabbccdd"
	publish(t, b, id)
	os.WriteFile(filepath.Join(b.dir, id+".approved"), nil, 0600)
	b.Resolve(id)
	if state, _ := b.State(id); state != ApprovalUnknown {
		t.Fatalf("estado tras resolver = %s", state)
	}
}

// El mensaje al agente no puede contener nada que le sirva para autoaprobarse.
func TestApprovalInstructionsCarryNoToken(t *testing.T) {
	msg := ApprovalInstructions("00112233aabbccdd", "ambiente prod", "kubectl delete ns staging")
	if strings.Contains(strings.ToLower(msg), "confirm_token") {
		t.Fatalf("el mensaje le ofrece un token al agente: %s", msg)
	}
	if !strings.Contains(msg, "check_approval") {
		t.Fatalf("el mensaje no le dice cómo consultar: %s", msg)
	}
}

func TestBrokerDisabledWhenNoDir(t *testing.T) {
	if MakeApprovalBroker("") != nil {
		t.Fatal("sin directorio el broker tiene que quedar deshabilitado")
	}
}

// Con el broker activo, una acción en prod no le devuelve token al agente.
func TestGateWithBrokerGivesNoTokenToTheAgent(t *testing.T) {
	dir := t.TempDir()
	app := &App{
		confirmer: MakeConfirmer(),
		audit:     MakeAuditor(filepath.Join(dir, "audit.jsonl")),
		approvals: MakeApprovalBroker(filepath.Join(dir, "approvals")),
	}
	prod := &Environment{Id: "prod-k8s", Kind: "ssh", Class: "prod", Criticality: "high"}

	msg := app.gate("run_command", prod, "kubectl delete ns staging", "")
	if msg == "" {
		t.Fatal("prod tiene que requerir aprobación")
	}
	if strings.Contains(strings.ToLower(msg), "confirm_token=\"") {
		t.Fatalf("le entregó un token usable al agente: %s", msg)
	}
	id := regexp.MustCompile(`solicitud: ([0-9a-f]{16})`).FindStringSubmatch(msg)
	if id == nil {
		t.Fatalf("no publicó un id consultable: %s", msg)
	}

	// mientras nadie apruebe, reintentar con el id no habilita nada
	if out := app.gate("run_command", prod, "kubectl delete ns staging", id[1]); !strings.Contains(out, "esperando") {
		t.Fatalf("un id sin aprobar no puede dejar pasar: %q", out)
	}

	// la persona aprueba por el canal que sea
	os.WriteFile(filepath.Join(dir, "approvals", id[1]+".approved"), []byte("ndf"), 0600)
	if out := app.gate("run_command", prod, "kubectl delete ns staging", id[1]); out != "" {
		t.Fatalf("una aprobación humana tiene que dejar pasar: %q", out)
	}

	// y no puede reusarse para una segunda ejecución
	if out := app.gate("run_command", prod, "kubectl delete ns staging", id[1]); out == "" {
		t.Fatal("la aprobación se reutilizó para una segunda ejecución")
	}
}

func TestGateWithBrokerRespectsDenial(t *testing.T) {
	dir := t.TempDir()
	app := &App{
		confirmer: MakeConfirmer(),
		audit:     MakeAuditor(filepath.Join(dir, "audit.jsonl")),
		approvals: MakeApprovalBroker(filepath.Join(dir, "approvals")),
	}
	prod := &Environment{Id: "prod-k8s", Kind: "ssh", Class: "prod"}
	msg := app.gate("run_command", prod, "kubectl delete ns staging", "")
	id := regexp.MustCompile(`solicitud: ([0-9a-f]{16})`).FindStringSubmatch(msg)[1]
	os.WriteFile(filepath.Join(dir, "approvals", id+".denied"), nil, 0600)

	out := app.gate("run_command", prod, "kubectl delete ns staging", id)
	if !strings.Contains(out, "RECHAZADO") {
		t.Fatalf("una denegación tiene que frenar: %q", out)
	}
}

// Sin broker se mantiene el flujo en dos fases de siempre.
func TestGateWithoutBrokerKeepsTwoPhaseFlow(t *testing.T) {
	app := &App{confirmer: MakeConfirmer(), audit: MakeAuditor(filepath.Join(t.TempDir(), "audit.jsonl"))}
	prod := &Environment{Id: "prod-k8s", Kind: "ssh", Class: "prod"}
	msg := app.gate("run_command", prod, "kubectl get pods", "")
	if !strings.Contains(msg, "confirm_token=") {
		t.Fatalf("sin broker el flujo sigue siendo el de dos fases: %s", msg)
	}
}
