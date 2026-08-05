// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Handoff de sesión. El traspaso entre un agente que diseña y otro que
// implementa hoy se hace a mano, copiando y pegando lo que pasó. Acá se
// empaqueta el estado del Workbench —ambientes, bloques abiertos, qué se
// ejecutó y con qué resultado— en un texto que otro agente puede consumir.
//
// Todo lo que sale pasa por la redacción: el handoff está pensado para
// mandárselo a otro modelo, que es exactamente el caso en el que una credencial
// filtrada viaja más lejos.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const HandoffAuditEntries = 40

type auditEntry struct {
	Ts       string `json:"ts"`
	Tool     string `json:"tool"`
	Env      string `json:"env"`
	Detail   string `json:"detail"`
	Decision string `json:"decision"`
}

// readRecentAudit lee las últimas entradas del audit. Una línea corrupta se
// salta: el handoff no puede fallar porque el log tenga una escritura a medias.
func readRecentAudit(path string, limit int) []auditEntry {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var all []auditEntry
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry auditEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		all = append(all, entry)
	}
	if len(all) > limit {
		all = all[len(all)-limit:]
	}
	return all
}

// SummarizeAuditForHandoff describe qué se hizo y qué quedó trabado, que es lo
// que el siguiente agente necesita saber para no repetirlo.
func SummarizeAuditForHandoff(entries []auditEntry) string {
	if len(entries) == 0 {
		return "Sin acciones registradas.\n"
	}
	var b strings.Builder
	var blocked, errored int
	for _, e := range entries {
		switch {
		case strings.HasPrefix(e.Decision, "error"):
			errored++
		case e.Decision == "confirmation_required" || e.Decision == "human_approval_required":
			blocked++
		}
		fmt.Fprintf(&b, "- [%s] %s en %s: %s → %s\n", e.Ts, e.Tool, e.Env, e.Detail, e.Decision)
	}
	if blocked > 0 || errored > 0 {
		fmt.Fprintf(&b, "\nPendientes: %d esperando aprobación, %d con error.\n", blocked, errored)
	}
	return b.String()
}

// BuildHandoff arma el documento. Recibe las piezas ya obtenidas para que la
// función sea testeable sin la app corriendo.
func BuildHandoff(catalog *Catalog, blocksJSON string, entries []auditEntry) string {
	var b strings.Builder
	b.WriteString("# Handoff de sesión — Nexus Workbench\n\n")

	b.WriteString("## Ambientes disponibles\n\n")
	b.WriteString("local — Local (class=personal)\n")
	for _, e := range catalog.Environments {
		fmt.Fprintf(&b, "%s — %s (kind=%s, class=%s, criticality=%s)", e.Id, e.Name, e.Kind, e.Class, e.Criticality)
		if e.NeedsConfirmation() {
			b.WriteString(" [REQUIERE CONFIRMACIÓN]")
		}
		b.WriteString("\n")
	}

	b.WriteString("\n## Bloques abiertos\n\n")
	if strings.TrimSpace(blocksJSON) == "" {
		b.WriteString("(no se pudieron leer)\n")
	} else {
		b.WriteString(strings.TrimSpace(blocksJSON) + "\n")
	}

	fmt.Fprintf(&b, "\n## Últimas %d acciones\n\n", len(entries))
	b.WriteString(SummarizeAuditForHandoff(entries))

	b.WriteString("\n## Reglas que siguen vigentes\n\n")
	b.WriteString("- Los ambientes prod/work y los comandos destructivos requieren confirmación; no la asumas dada.\n")
	b.WriteString("- El contexto efectivo del shell puede escalar un comando aunque el ambiente figure como lab.\n")
	b.WriteString("- Las credenciales de este documento están redactadas: si necesitás una, pedila, no la infieras.\n")

	out, _ := Redact(b.String())
	return out
}
