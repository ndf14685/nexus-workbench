// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Failover entre agentes de IA. Los CLIs por suscripción se quedan sin cuota a
// mitad de una operación y hoy eso deja el trabajo cortado: el botón lanza un
// CLI y si ese CLI no puede responder, no hay a dónde ir. Acá se declara una
// cadena de reemplazo por agente y se detecta el agotamiento leyendo lo que el
// CLI imprime, que es la única señal que dan sin API de cuota.
package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

type Agent struct {
	Id          string   `yaml:"id" json:"id"`
	Name        string   `yaml:"name" json:"name"`
	Command     string   `yaml:"command" json:"command"`
	Icon        string   `yaml:"icon,omitempty" json:"icon,omitempty"`
	Color       string   `yaml:"color,omitempty" json:"color,omitempty"`
	Environment string   `yaml:"environment,omitempty" json:"environment,omitempty"`
	Fallbacks   []string `yaml:"fallbacks,omitempty" json:"fallbacks,omitempty"`
}

// Señales de agotamiento de cuota o de límite de uso. Cada CLI lo dice a su
// manera y ninguno expone un código estable, así que se reconoce por texto.
var quotaExhaustedPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(usage|rate)\s+limit\s+(reached|exceeded|hit)\b`),
	regexp.MustCompile(`(?i)\bquota\s+(exceeded|exhausted|reached)\b`),
	regexp.MustCompile(`(?i)\bout\s+of\s+(credits|quota|tokens)\b`),
	regexp.MustCompile(`(?i)\binsufficient\s+(credits|quota|balance)\b`),
	regexp.MustCompile(`(?i)\byou'?ve\s+reached\s+your\b.*\blimit\b`),
	regexp.MustCompile(`(?i)\b(429|too\s+many\s+requests)\b`),
	regexp.MustCompile(`(?i)\bplan\s+limit\s+reached\b`),
	regexp.MustCompile(`(?i)\btry\s+again\s+(in|after)\b.*\b(hour|minute)s?\b`),
	regexp.MustCompile(`(?i)\bupgrade\s+(your\s+)?plan\b`),
}

// Señales de que el CLI directamente no arrancó: también hay que caer al
// siguiente, aunque el motivo no sea la cuota.
var agentUnavailablePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)command not found`),
	regexp.MustCompile(`(?i)\bnot recognized as (an )?internal or external command\b`),
	regexp.MustCompile(`(?i)\b(authentication|login) (failed|required)\b`),
	regexp.MustCompile(`(?i)\bplease (run )?.*\blogin\b`),
	regexp.MustCompile(`(?i)\bno such file or directory\b`),
}

func IsQuotaExhausted(output string) bool {
	return matchesAny(output, quotaExhaustedPatterns)
}

func IsAgentUnavailable(output string) bool {
	return matchesAny(output, agentUnavailablePatterns)
}

// ShouldFailover decide si conviene pasar al siguiente agente de la cadena.
func ShouldFailover(output string) (bool, string) {
	if IsQuotaExhausted(output) {
		return true, "cuota agotada"
	}
	if IsAgentUnavailable(output) {
		return true, "el CLI no está disponible"
	}
	return false, ""
}

func matchesAny(s string, patterns []*regexp.Regexp) bool {
	if strings.TrimSpace(s) == "" {
		return false
	}
	clean := stripAnsi(s)
	for _, re := range patterns {
		if re.MatchString(clean) {
			return true
		}
	}
	return false
}

func (c *Catalog) Agent(id string) (*Agent, error) {
	for i := range c.Agents {
		if c.Agents[i].Id == id {
			return &c.Agents[i], nil
		}
	}
	return nil, fmt.Errorf("agente %q no está en el catálogo", id)
}

// AgentChain arma el orden de intento: el agente pedido y sus reemplazos. Corta
// los ciclos porque la cadena la escribe una persona en un YAML y dos agentes
// que se listan mutuamente como fallback son un error fácil de cometer.
func (c *Catalog) AgentChain(id string) ([]*Agent, error) {
	first, err := c.Agent(id)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{id: true}
	chain := []*Agent{first}
	queue := append([]string{}, first.Fallbacks...)
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		if seen[next] {
			continue
		}
		seen[next] = true
		agent, err := c.Agent(next)
		if err != nil {
			continue // un fallback que ya no existe no puede romper la cadena entera
		}
		chain = append(chain, agent)
		queue = append(queue, agent.Fallbacks...)
	}
	return chain, nil
}

// AgentStartupGrace es lo que se espera antes de mirar que imprimio el CLI. Un
// aviso de cuota aparece en los primeros segundos; esperar mas solo retrasa el
// failover mientras el usuario mira una terminal muerta.
const AgentStartupGrace = 3 * time.Second

// agentStartupOutput lee el arranque del agente para decidir si sirve. Si no se
// puede leer devuelve vacio: sin senal no hacemos failover, porque un agente
// sano no puede perderse por un scrollback que todavia no esta montado.
func (app *App) agentStartupOutput(ctx context.Context, tabId string, blockId string) string {
	time.Sleep(AgentStartupGrace)
	ref := strings.TrimSpace(blockId)
	if ref == "" {
		return ""
	}
	if !strings.HasPrefix(ref, "block:") {
		ref = "block:" + ref
	}
	out, err := app.wave.RunWsh(ctx, "", tabId, "termscrollback", "-b", ref)
	if err != nil {
		return ""
	}
	return out
}
