// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func TestIsQuotaExhausted(t *testing.T) {
	exhausted := []string{
		"Usage limit reached. Your limit resets at 3pm.",
		"You've reached your usage limit for this model",
		"Error: quota exceeded for this billing period",
		"insufficient credits remaining",
		"HTTP 429 Too Many Requests",
		"Rate limit exceeded, try again in 5 hours",
		"Plan limit reached — upgrade your plan to continue",
		"out of credits",
	}
	for _, out := range exhausted {
		if !IsQuotaExhausted(out) {
			t.Errorf("no detectó agotamiento en %q", out)
		}
	}
	normal := []string{
		"", "Listo, apliqué el cambio en 3 archivos.",
		"warning: rate limiting is enabled on this endpoint",
		"El limite de la funcion es 10",
		"kubectl get pods -n nexus",
	}
	for _, out := range normal {
		if IsQuotaExhausted(out) {
			t.Errorf("falso positivo de cuota en %q", out)
		}
	}
}

func TestShouldFailoverExplainsWhy(t *testing.T) {
	ok, reason := ShouldFailover("Usage limit reached")
	if !ok || reason != "cuota agotada" {
		t.Fatalf("esperaba failover por cuota, hubo (%v,%q)", ok, reason)
	}
	ok, reason = ShouldFailover("bash: codex: command not found")
	if !ok || reason != "el CLI no está disponible" {
		t.Fatalf("esperaba failover por CLI ausente, hubo (%v,%q)", ok, reason)
	}
	if ok, _ := ShouldFailover("todo bien"); ok {
		t.Fatal("no debería hacer failover con salida normal")
	}
}

func testCatalog() *Catalog {
	return &Catalog{Version: 1, Agents: []Agent{
		{Id: "codex", Name: "Codex", Command: "codex", Fallbacks: []string{"claude", "ollama"}},
		{Id: "claude", Name: "Claude Code", Command: "claude", Fallbacks: []string{"ollama"}},
		{Id: "ollama", Name: "Ollama local", Command: "ollama run qwen"},
		{Id: "solo", Name: "Sin reemplazo", Command: "solo"},
	}}
}

func TestAgentChainOrder(t *testing.T) {
	chain, err := testCatalog().AgentChain("codex")
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, a := range chain {
		got = append(got, a.Id)
	}
	want := []string{"codex", "claude", "ollama"}
	if len(got) != len(want) {
		t.Fatalf("cadena = %v, esperaba %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("cadena = %v, esperaba %v", got, want)
		}
	}
}

func TestAgentChainWithoutFallbacks(t *testing.T) {
	chain, _ := testCatalog().AgentChain("solo")
	if len(chain) != 1 || chain[0].Id != "solo" {
		t.Fatalf("un agente sin reemplazos es una cadena de uno: %v", chain)
	}
}

// La cadena la escribe una persona en un YAML: dos agentes que se listan
// mutuamente no pueden colgar el arranque.
func TestAgentChainBreaksCycles(t *testing.T) {
	cat := &Catalog{Version: 1, Agents: []Agent{
		{Id: "a", Command: "a", Fallbacks: []string{"b"}},
		{Id: "b", Command: "b", Fallbacks: []string{"a"}},
	}}
	chain, err := cat.AgentChain("a")
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 2 {
		t.Fatalf("esperaba 2 agentes sin repetir, hubo %d", len(chain))
	}
}

func TestAgentChainIgnoresMissingFallback(t *testing.T) {
	cat := &Catalog{Version: 1, Agents: []Agent{
		{Id: "a", Command: "a", Fallbacks: []string{"no-existe", "b"}},
		{Id: "b", Command: "b"},
	}}
	chain, err := cat.AgentChain("a")
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 2 || chain[1].Id != "b" {
		t.Fatalf("un fallback inexistente no puede romper la cadena: %v", chain)
	}
}
