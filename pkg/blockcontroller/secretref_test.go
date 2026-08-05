// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"fmt"
	"strings"
	"testing"
)

func withSecrets(t *testing.T, store map[string]string) {
	t.Helper()
	prev := lookupSecret
	lookupSecret = func(name string) (string, bool, error) {
		value, ok := store[name]
		return value, ok, nil
	}
	t.Cleanup(func() { lookupSecret = prev })
}

func TestSecretRefNames(t *testing.T) {
	cases := map[string][]string{
		"${secret:PROD_AWS_PROFILE}":     {"PROD_AWS_PROFILE"},
		"prefix-${secret:A}-${secret:B}": {"A", "B"},
		"sin referencias":                nil,
		"":                               nil,
		"${secreto:NO}":                  nil,
		"$secret:NO":                     nil,
		// el almacén no admite puntos ni guiones en los nombres
		"${secret:con.punto}": nil,
	}
	for in, want := range cases {
		got := SecretRefNames(in)
		if len(got) != len(want) {
			t.Fatalf("SecretRefNames(%q) = %v, esperaba %v", in, got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("SecretRefNames(%q) = %v, esperaba %v", in, got, want)
			}
		}
	}
}

func TestResolveEnvSecretRefsSubstitutesValues(t *testing.T) {
	withSecrets(t, map[string]string{"PROD_AWS_PROFILE": "prod-admin", "TOKEN": "abc123"})
	env := map[string]string{
		"AWS_PROFILE": "${secret:PROD_AWS_PROFILE}",
		"HEADER":      "Bearer ${secret:TOKEN}",
		"AWS_REGION":  "us-east-1",
	}
	out, err := ResolveEnvSecretRefs(env)
	if err != nil {
		t.Fatal(err)
	}
	if out["AWS_PROFILE"] != "prod-admin" {
		t.Fatalf("no se sustituyó la referencia: %q", out["AWS_PROFILE"])
	}
	if out["HEADER"] != "Bearer abc123" {
		t.Fatalf("no se sustituyó una referencia embebida: %q", out["HEADER"])
	}
	if out["AWS_REGION"] != "us-east-1" {
		t.Fatalf("se alteró un valor literal: %q", out["AWS_REGION"])
	}
}

func TestResolveEnvSecretRefsLeavesPlainValuesUntouched(t *testing.T) {
	withSecrets(t, map[string]string{})
	env := map[string]string{"PATH": "/usr/bin", "AWS_REGION": "us-east-1"}
	out, err := ResolveEnvSecretRefs(env)
	if err != nil {
		t.Fatalf("un mapa sin referencias no puede fallar: %v", err)
	}
	if out["PATH"] != "/usr/bin" || out["AWS_REGION"] != "us-east-1" {
		t.Fatalf("se alteraron valores literales: %v", out)
	}
}

// Un secreto ausente tiene que frenar el arranque. Si resolviéramos a "" el
// proceso arrancaría igual y correría sin credencial contra el destino real.
func TestResolveEnvSecretRefsFailsOnMissingSecret(t *testing.T) {
	withSecrets(t, map[string]string{})
	_, err := ResolveEnvSecretRefs(map[string]string{"AWS_PROFILE": "${secret:NO_EXISTE}"})
	if err == nil {
		t.Fatal("un secreto faltante tiene que ser error, no string vacío")
	}
	for _, want := range []string{"AWS_PROFILE", "NO_EXISTE", "wsh secret set"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("el error tiene que mencionar %q: %v", want, err)
		}
	}
}

// Si el almacén no está disponible tampoco arrancamos con la variable vacía.
func TestResolveEnvSecretRefsFailsWhenStoreIsUnavailable(t *testing.T) {
	prev := lookupSecret
	lookupSecret = func(string) (string, bool, error) { return "", false, fmt.Errorf("safeStorage caído") }
	t.Cleanup(func() { lookupSecret = prev })

	_, err := ResolveEnvSecretRefs(map[string]string{"KUBECONFIG": "${secret:PROD_KUBECONFIG}"})
	if err == nil {
		t.Fatal("un almacén caído tiene que ser error")
	}
	if !strings.Contains(err.Error(), "safeStorage caído") {
		t.Fatalf("el error tiene que propagar la causa: %v", err)
	}
}

// Un pánico del almacén no puede tumbar el spawn del bloque.
func TestResolveEnvSecretRefsSurvivesStorePanic(t *testing.T) {
	prev := lookupSecret
	lookupSecret = func(string) (string, bool, error) { panic("cliente rpc nil") }
	t.Cleanup(func() { lookupSecret = prev })

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("el pánico se escapó de la resolución: %v", r)
		}
	}()
	if _, err := ResolveEnvSecretRefs(map[string]string{"X": "${secret:A}"}); err == nil {
		t.Fatal("un pánico del almacén tiene que devolverse como error")
	}
}
