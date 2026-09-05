// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Redacción de credenciales en el borde del MCP. Todo lo que sale hacia el
// agente (textResult) y todo lo que se persiste en la auditoría pasa por acá:
// el scrollback de una terminal es texto arbitrario del ambiente y puede
// contener tokens que el modelo no tiene por qué recibir.
package main

import (
	"regexp"
	"strings"
)

const RedactedMarker = "«REDACTADO»"

// Los patrones con un grupo de captura conservan ese grupo (el nombre de la
// variable, el esquema de la URL) y redactan sólo el valor, para que el agente
// pueda seguir razonando sobre qué se seteó sin ver el secreto.
var redactPatterns = []*regexp.Regexp{
	// bloques PEM completos
	regexp.MustCompile(`(?s)(-----BEGIN [A-Z ]*PRIVATE KEY-----).*?(-----END [A-Z ]*PRIVATE KEY-----)`),
	// tokens con prefijo reconocible
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bASIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}`),
	regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\bsk-proj-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9]{32,}`),
	regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`),
	regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9-]{10,}`),
	regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\bnpm_[A-Za-z0-9]{30,}`),
	regexp.MustCompile(`\bhf_[A-Za-z0-9]{30,}`),
	regexp.MustCompile(`\bdop_v1_[A-Za-z0-9]{30,}`),
	// JWT de tres segmentos
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	// cabeceras de autorización
	regexp.MustCompile(`(?i)((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+)\S+`),
	regexp.MustCompile(`(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]{20,}`),
	// credenciales embebidas en una URL
	regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@]+:)[^\s@/]+(@)`),
	// campos de kubeconfig y similares en YAML/JSON
	regexp.MustCompile(`(?i)((?:client-key-data|client-certificate-data|token|id-token|refresh-token)\s*:\s*)\S{16,}`),
	// asignaciones genéricas: NOMBRE=valor / "nombre": "valor".
	//
	// El VALOR tiene que parecer un secreto: una tira de caracteres de token
	// (letras, dígitos, ._~+/=-) sin espacios ni paréntesis ni corchetes.
	// Antes valía "cualquier cosa sin espacios de 6+", y eso tachaba código:
	// `tokens = int(usage["total_tokens"])` salía como
	// `tokens = «REDACTADO»"total_tokens")` y el juez de una misión pedía tres
	// veces el archivo "sin redactar" (2026-09-04). Un secreto real no trae
	// `(` ni `[`; un contador (`max_tokens = 4096`) no llega a 16 chars.
	regexp.MustCompile(`(?i)(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*"?\s*[:=]\s*)"[A-Za-z0-9._~+/=-]{8,}"`),
	regexp.MustCompile(`(?i)(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*\s*[:=]\s*)'[A-Za-z0-9._~+/=-]{8,}'`),
	regexp.MustCompile(`(?i)(\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*\s*[:=]\s*)[A-Za-z0-9._~+/=-]{16,}`),
}

// Redact devuelve el texto con las credenciales reemplazadas y cuántas se
// reemplazaron.
func Redact(s string) (string, int) {
	if s == "" {
		return s, 0
	}
	count := 0
	out := s
	for _, re := range redactPatterns {
		out = re.ReplaceAllStringFunc(out, func(match string) string {
			groups := re.FindStringSubmatch(match)
			count++
			if len(groups) == 3 {
				return groups[1] + RedactedMarker + groups[2]
			}
			if len(groups) == 2 {
				return groups[1] + RedactedMarker
			}
			return RedactedMarker
		})
	}
	return out, count
}

// RedactForAgent redacta y, si hubo cambios, se lo dice explícitamente al
// agente: una redacción silenciosa lo llevaría a interpretar mal la salida.
func RedactForAgent(s string) string {
	out, n := Redact(s)
	if n == 0 {
		return out
	}
	noun := "credencial"
	if n > 1 {
		noun = "credenciales"
	}
	return out + "\n\n[nexus-workbench: se ocultaron " + itoa(n) + " " + noun + " de esta salida antes de entregarla]"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b strings.Builder
	digits := []byte{}
	for n > 0 {
		digits = append(digits, byte('0'+n%10))
		n /= 10
	}
	for i := len(digits) - 1; i >= 0; i-- {
		b.WriteByte(digits[i])
	}
	return b.String()
}
