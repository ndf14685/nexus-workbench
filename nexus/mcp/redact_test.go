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
	awsKeyId   = "AKIA" + strings.Repeat("Q", 16)
	awsKeyId2  = "AKIA" + strings.Repeat("R", 16)
	githubPat  = "ghp_" + strings.Repeat("z", 36)
	pemBody    = "b3BlbnNzaC1rZXktdjEAAAAA"
	pemBlock   = "-----BEGIN OPENSSH PRIVATE" + " KEY-----\n" + pemBody + "\n-----END OPENSSH PRIVATE" + " KEY-----"
)

func TestRedactHidesCredentials(t *testing.T) {
	cases := []struct {
		name  string
		input string
		leak  string
	}{
		{"aws access key id", "AWS_ACCESS_KEY_ID=" + awsKeyId, awsKeyId},
		{"github pat", "remote: https://" + githubPat + "@github.com", githubPat},
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
		{"private key block", pemBlock, pemBody},
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
	in := "A=" + awsKeyId + " B=" + awsKeyId2
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

func TestRedactLeavesCodeAboutTokensAlone(t *testing.T) {
	// 2026-09-04: el patrón genérico tachaba código porque el nombre de la
	// variable contenía "token" y el valor era "cualquier cosa sin espacios".
	// El juez de una misión vio `tokens = «REDACTADO»"total_tokens")` y pidió
	// tres veces el archivo "sin redactar": no había nada que redactar.
	ordinary := []string{
		`tokens = int(usage["total_tokens"])`,
		`token_delta = enabled["total_tokens"] - disabled["total_tokens"]`,
		`context_max_tokens=replay["context_max_tokens"],`,
		`max_tokens = 4096`,
		`"total_tokens": 8129,`,
		`tokens used: 4,406`,
		`self.token_count += len(chunk)`,
		`api_key = os.environ.get("OPENAI_API_KEY")`,
	}
	for _, line := range ordinary {
		out, n := Redact(line)
		if n != 0 || out != line {
			t.Fatalf("se redactó código que no contiene ningún secreto:\ninput:  %s\noutput: %s", line, out)
		}
	}
}

func TestRedactStillHidesRealAssignedSecrets(t *testing.T) {
	cases := []struct{ input, leak string }{
		{"GITHUB_TOKEN=9f8e7d6c5b4a392817065544332211aa", "9f8e7d6c5b4a392817065544332211aa"},
		{`api_key = "sk-live-0123456789abcdef"`, "sk-live-0123456789abcdef"},
		{"token: 9f8e7d6c5b4a39281706", "9f8e7d6c5b4a39281706"},
		{`"password": "correct-horse-battery"`, "correct-horse-battery"},
	}
	for _, tc := range cases {
		out, n := Redact(tc.input)
		if n == 0 || strings.Contains(out, tc.leak) {
			t.Fatalf("el secreto sobrevivió:\ninput:  %s\noutput: %s", tc.input, out)
		}
	}
}
