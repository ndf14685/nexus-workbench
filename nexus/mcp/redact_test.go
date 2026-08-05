// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import "strings"

import "testing"

// Los fixtures se arman en runtime a propósito: escritos como literales, el
// escaneo de secretos de GitHub los toma por credenciales reales y bloquea el
// push del repo.
var (
	googleKey  = "AIza" + strings.Repeat("a", 35) // una API key de Google son 39 caracteres
	slackToken = "xoxb-" + strings.Repeat("1", 10) + "-" + strings.Repeat("2", 10) + "-" + strings.Repeat("a", 16)
)

func TestRedactHidesCredentials(t *testing.T) {
	cases := []struct {
		name  string
		input string
		leak  string
	}{
		{"aws access key id", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"},
		{"github pat", "remote: https://ghp_016BfW4i4SbYhh41TKWuJxyrQQQQQQQQQQQQ@github.com", "ghp_016BfW4i4SbYhh41TKWuJxyrQQQQQQQQQQQQ"},
		{"anthropic key", "export ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA"},
		{"openai key", "OPENAI_API_KEY=sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBB", "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBB"},
		{"google api key", "key=" + googleKey, googleKey},
		{"slack token", slackToken, slackToken},
		{"jwt", "Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", "eyJhbGciOiJIUzI1NiJ9"},
		{"bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345"},
		{"password assignment", `DB_PASSWORD="hunter2-super-secret"`, "hunter2-super-secret"},
		{"token assignment", "registry_token: 9f8e7d6c5b4a39281706", "9f8e7d6c5b4a39281706"},
		{"url credentials", "psql postgres://admin:s3cr3tp4ss@db.internal:5432/prod", "s3cr3tp4ss"},
		{"kubeconfig client key", "    client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo=", "LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo="},
		{"private key block", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAA"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, n := Redact(tc.input)
			if strings.Contains(out, tc.leak) {
				t.Fatalf("el secreto sobrevivió a la redacción:\ninput:  %s\noutput: %s", tc.input, out)
			}
			if n == 0 {
				t.Fatalf("no se contabilizó ninguna redacción para %q", tc.input)
			}
			if !strings.Contains(out, RedactedMarker) {
				t.Fatalf("falta el marcador %q en %q", RedactedMarker, out)
			}
		})
	}
}

func TestRedactKeepsOrdinaryOutput(t *testing.T) {
	ordinary := []string{
		"total 48\ndrwxr-xr-x 2 ndf ndf 4096 Aug  5 11:49 nexus",
		"NAME                     READY   STATUS    RESTARTS   AGE\nnexus-api-7d9f8b6c4-x2k9p 1/1    Running   0          3d",
		"commit 81af8b24 fix(permissions): el micrófono quedaba trabado",
		"go version go1.25.6 linux/amd64",
		"error: connection refused on 192.168.50.105:30845",
	}
	for _, in := range ordinary {
		out, n := Redact(in)
		if n != 0 || out != in {
			t.Fatalf("falso positivo: %q quedó como %q (%d redacciones)", in, out, n)
		}
	}
}

func TestRedactCountsEveryOccurrence(t *testing.T) {
	in := "A=AKIAIOSFODNN7EXAMPLE B=AKIAIOSFODNN7EXAMPLF"
	out, n := Redact(in)
	if n != 2 {
		t.Fatalf("esperaba 2 redacciones, hubo %d (%q)", n, out)
	}
}

func TestRedactPreservesAssignmentKeyName(t *testing.T) {
	// el agente tiene que poder razonar sobre QUÉ variable se seteó, sin ver el valor
	out, _ := Redact("export DB_PASSWORD=hunter2-super-secret")
	if !strings.Contains(out, "DB_PASSWORD") {
		t.Fatalf("se perdió el nombre de la variable: %q", out)
	}
}
