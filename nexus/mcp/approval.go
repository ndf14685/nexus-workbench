// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Aprobación fuera de banda. El gate en dos fases le devuelve el confirm_token
// al propio agente y le pide que consulte al usuario antes de reusarlo: eso es
// un sistema de honor, y el agente es exactamente la parte cuya obediencia no
// queremos tener que asumir.
//
// Con el broker habilitado, las acciones de mayor riesgo publican una solicitud
// en disco y el agente NO recibe token: sólo un id para consultar. La
// aprobación la escribe una persona por el canal que sea (OpenClaw/Telegram
// tienen ya el lado humano, la app puede sumar un botón). El transporte no
// importa: el contrato es el directorio.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const ApprovalTTL = 10 * time.Minute

// Un id que llega desde afuera se usa para construir una ruta: sólo hex.
var approvalIdPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

type ApprovalRequest struct {
	Id      string `json:"id"`
	Tool    string `json:"tool"`
	Env     string `json:"env"`
	Class   string `json:"class"`
	Detail  string `json:"detail"`
	Reason  string `json:"reason"`
	Created string `json:"created"`
	Expires string `json:"expires"`
}

type ApprovalState string

const (
	ApprovalPending  ApprovalState = "pending"
	ApprovalApproved ApprovalState = "approved"
	ApprovalDenied   ApprovalState = "denied"
	ApprovalExpired  ApprovalState = "expired"
	ApprovalUnknown  ApprovalState = "unknown"
)

type ApprovalBroker struct {
	dir string
}

func MakeApprovalBroker(dir string) *ApprovalBroker {
	if dir == "" {
		return nil
	}
	return &ApprovalBroker{dir: dir}
}

func (b *ApprovalBroker) path(id string, suffix string) (string, error) {
	if !approvalIdPattern.MatchString(id) {
		return "", fmt.Errorf("id de aprobación inválido")
	}
	return filepath.Join(b.dir, id+suffix), nil
}

// Publish deja la solicitud en disco. El detail va redactado: lo va a leer una
// persona por un canal externo, y un token en un mensaje de Telegram es un
// token filtrado.
func (b *ApprovalBroker) Publish(id string, req ApprovalRequest) error {
	if err := os.MkdirAll(b.dir, 0700); err != nil {
		return err
	}
	path, err := b.path(id, ".json")
	if err != nil {
		return err
	}
	safeDetail, _ := Redact(req.Detail)
	req.Id = id
	req.Detail = safeDetail
	req.Created = time.Now().Format(time.RFC3339)
	req.Expires = time.Now().Add(ApprovalTTL).Format(time.RFC3339)
	data, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}

// State resuelve el estado mirando los archivos marcador. La denegación gana
// sobre la aprobación: si aparecieron las dos, la respuesta segura es no.
func (b *ApprovalBroker) State(id string) (ApprovalState, *ApprovalRequest) {
	reqPath, err := b.path(id, ".json")
	if err != nil {
		return ApprovalUnknown, nil
	}
	raw, err := os.ReadFile(reqPath)
	if err != nil {
		return ApprovalUnknown, nil
	}
	var req ApprovalRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return ApprovalUnknown, nil
	}
	if denied, _ := b.path(id, ".denied"); fileExists(denied) {
		return ApprovalDenied, &req
	}
	expires, err := time.Parse(time.RFC3339, req.Expires)
	if err == nil && time.Now().After(expires) {
		return ApprovalExpired, &req
	}
	if approved, _ := b.path(id, ".approved"); fileExists(approved) {
		return ApprovalApproved, &req
	}
	return ApprovalPending, &req
}

// Resolve borra los marcadores de una solicitud ya consumida para que una
// aprobación no pueda reusarse en una segunda ejecución.
func (b *ApprovalBroker) Resolve(id string) {
	for _, suffix := range []string{".json", ".approved", ".denied"} {
		if path, err := b.path(id, suffix); err == nil {
			os.Remove(path)
		}
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ApprovalInstructions es lo que se le dice al agente. No incluye ningún token:
// el agente sólo puede esperar y consultar.
func ApprovalInstructions(id string, reason string, detail string) string {
	safeDetail, _ := Redact(detail)
	return strings.Join([]string{
		fmt.Sprintf("APROBACIÓN HUMANA REQUERIDA (%s).", reason),
		fmt.Sprintf("solicitud: %s", id),
		fmt.Sprintf("acción: %s", safeDetail),
		"No hay token que puedas usar: la aprobación la da una persona por fuera de esta conversación.",
		fmt.Sprintf("Avisale al usuario y después consultá con check_approval(id=%q). Expira en 10 minutos.", id),
	}, "\n")
}
