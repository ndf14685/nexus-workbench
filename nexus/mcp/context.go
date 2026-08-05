// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Guardia de contexto efectivo. La clase del ambiente del catálogo dice a qué
// máquina nos conectamos, no contra qué cluster o cuenta apunta el shell. El
// accidente típico es correr el comando correcto en el cluster equivocado: un
// ambiente marcado "lab" cuyo kubeconfig quedó apuntando a producción.
package main

import (
	"context"
	"regexp"
	"strings"
	"time"
)

const ContextCacheTTL = 15 * time.Second

// Herramientas cuyo destino real lo decide un contexto ambiental, no el comando.
var contextualTools = map[string]string{
	"kubectl":   "kubernetes",
	"helm":      "kubernetes",
	"kustomize": "kubernetes",
	"k9s":       "kubernetes",
	"flux":      "kubernetes",
	"argocd":    "kubernetes",
	"aws":       "aws",
	"eksctl":    "aws",
	"gcloud":    "gcloud",
	"kubectx":   "kubernetes",
	"terraform": "terraform",
	"tofu":      "terraform",
}

var productionContextPattern = regexp.MustCompile(`(?i)(^|[^a-z0-9])(prod|prd|production|live|master-prod|prod-[a-z0-9-]*|[a-z0-9-]*-prod)($|[^a-z0-9])`)

type EffectiveContext struct {
	Kind      string // kubernetes | aws | gcloud | terraform
	Name      string // nombre del contexto/perfil/proyecto/workspace
	Available bool   // false si no se pudo determinar
}

func (c EffectiveContext) LooksProduction() bool {
	return c.Available && IsProductionContext(c.Name)
}

func IsProductionContext(name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	return productionContextPattern.MatchString(name)
}

// CommandContextKind devuelve el tipo de contexto que gobierna al comando, o ""
// si el comando no depende de ninguno. Mira el primer token real, saltando
// asignaciones de entorno y sudo.
func CommandContextKind(command string) string {
	for _, token := range strings.Fields(command) {
		if strings.Contains(token, "=") && !strings.HasPrefix(token, "-") {
			continue // VAR=valor delante del comando
		}
		if token == "sudo" || token == "env" || token == "command" {
			continue
		}
		if idx := strings.LastIndex(token, "/"); idx >= 0 {
			token = token[idx+1:]
		}
		if kind, ok := contextualTools[token]; ok {
			return kind
		}
		return ""
	}
	return ""
}

// ContextProbe es el comando de sólo lectura que revela el contexto efectivo.
func ContextProbe(kind string) string {
	switch kind {
	case "kubernetes":
		return "kubectl config current-context"
	case "aws":
		return "aws configure list 2>/dev/null | awk '/profile/{print $2}'"
	case "gcloud":
		return "gcloud config get-value project 2>/dev/null"
	case "terraform":
		return "terraform workspace show 2>/dev/null"
	}
	return ""
}

// ParseProbeOutput limpia la salida del probe: los CLIs mezclan avisos y líneas
// vacías, y un "<not set>" o un error significan "no pude determinarlo".
func ParseProbeOutput(raw string) (string, bool) {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(stripAnsi(line))
		if line == "" {
			continue
		}
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "error") || strings.Contains(lower, "not set") || strings.Contains(lower, "command not found") {
			continue
		}
		if strings.Contains(lower, "warning") || strings.Contains(lower, "deprecated") {
			continue
		}
		if strings.ContainsAny(line, " \t") && !strings.Contains(line, "-") {
			continue
		}
		return line, true
	}
	return "", false
}

type contextCacheEntry struct {
	ctx     EffectiveContext
	expires time.Time
}

type ContextDetector struct {
	wave  *WaveAccess
	cache map[string]contextCacheEntry
}

func MakeContextDetector(wave *WaveAccess) *ContextDetector {
	return &ContextDetector{wave: wave, cache: map[string]contextCacheEntry{}}
}

// Detect corre el probe en el ambiente. Es de sólo lectura y su resultado se
// cachea unos segundos: un agente encadena varios comandos seguidos y no tiene
// sentido interrogar el shell en cada uno.
func (d *ContextDetector) Detect(ctx context.Context, env *Environment, tabId string, kind string) EffectiveContext {
	probe := ContextProbe(kind)
	if probe == "" {
		return EffectiveContext{Kind: kind}
	}
	key := env.Id + "|" + kind
	if entry, ok := d.cache[key]; ok && time.Now().Before(entry.expires) {
		return entry.ctx
	}
	out, err := d.wave.RunWsh(ctx, env.ConnName(), tabId, "run", "--quiet", "-c", probe)
	result := EffectiveContext{Kind: kind}
	if err == nil {
		if name, ok := ParseProbeOutput(out); ok {
			result = EffectiveContext{Kind: kind, Name: name, Available: true}
		}
	}
	d.cache[key] = contextCacheEntry{ctx: result, expires: time.Now().Add(ContextCacheTTL)}
	return result
}
