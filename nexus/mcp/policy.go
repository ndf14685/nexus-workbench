// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Gobernanza (ADR-0004): catálogo de ambientes, detección de comandos
// destructivos, confirmación en dos fases para operaciones sensibles y
// auditoría append-only en JSONL.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

const ConfirmTTL = 2 * time.Minute

var DestructivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(^|[;&|]\s*)rm\s+(-\w*\s+)*-\w*[rf]`),
	regexp.MustCompile(`\bmkfs\b|\bdd\s+if=`),
	regexp.MustCompile(`\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b`),
	regexp.MustCompile(`\bsystemctl\s+(stop|restart|disable|mask)\b`),
	regexp.MustCompile(`\bkubectl\s+(delete|drain|cordon)\b`),
	regexp.MustCompile(`\bdocker\s+(rm|rmi|kill|system\s+prune|volume\s+rm)\b`),
	regexp.MustCompile(`\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-\w*[fdx])`),
	regexp.MustCompile(`(?i)\b(drop|truncate)\s+(table|database)\b`),
	regexp.MustCompile(`\buserdel\b|\bgroupdel\b|\bcrontab\s+-r\b`),
	regexp.MustCompile(`>\s*/dev/sd[a-z]\b`),
}

type Environment struct {
	Id          string `yaml:"id" json:"id"`
	Name        string `yaml:"name" json:"name"`
	Kind        string `yaml:"kind" json:"kind"`
	Host        string `yaml:"host,omitempty" json:"host,omitempty"`
	Distro      string `yaml:"distro,omitempty" json:"distro,omitempty"`
	Class       string `yaml:"class" json:"class"`
	Criticality string `yaml:"criticality,omitempty" json:"criticality,omitempty"`
	Notes       string `yaml:"notes,omitempty" json:"notes,omitempty"`
}

// ConnName mapea el ambiente al nombre de conexión nativo de Wave.
func (e *Environment) ConnName() string {
	switch e.Kind {
	case "wsl":
		return "wsl://" + e.Distro
	case "ssh":
		return e.Host
	default:
		return ""
	}
}

func (e *Environment) NeedsConfirmation() bool {
	return e.Class == "prod" || e.Class == "work" || e.Criticality == "high"
}

type Catalog struct {
	Version      int           `yaml:"version"`
	Environments []Environment `yaml:"environments"`
}

func LoadCatalog(path string) (*Catalog, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("leyendo catálogo %s: %w", path, err)
	}
	var cat Catalog
	if err := yaml.Unmarshal(raw, &cat); err != nil {
		return nil, fmt.Errorf("parseando %s: %w", path, err)
	}
	if cat.Version != 1 {
		return nil, fmt.Errorf("catálogo %s: version debe ser 1", path)
	}
	return &cat, nil
}

func (c *Catalog) Get(id string) (*Environment, error) {
	for i := range c.Environments {
		if c.Environments[i].Id == id {
			return &c.Environments[i], nil
		}
	}
	return nil, fmt.Errorf("ambiente %q no está en el catálogo (usar list_environments)", id)
}

func IsDestructive(cmd string) bool {
	for _, re := range DestructivePatterns {
		if re.MatchString(cmd) {
			return true
		}
	}
	return false
}

// --- confirmación en dos fases ---

type pendingAction struct {
	fingerprint string
	expires     time.Time
}

type Confirmer struct {
	lock    sync.Mutex
	pending map[string]pendingAction
}

func MakeConfirmer() *Confirmer {
	return &Confirmer{pending: make(map[string]pendingAction)}
}

func fingerprint(parts ...string) string {
	return strings.Join(parts, "\x00")
}

func (c *Confirmer) Request(parts ...string) string {
	c.lock.Lock()
	defer c.lock.Unlock()
	buf := make([]byte, 8)
	rand.Read(buf)
	token := hex.EncodeToString(buf)
	c.pending[token] = pendingAction{fingerprint: fingerprint(parts...), expires: time.Now().Add(ConfirmTTL)}
	return token
}

func (c *Confirmer) Check(token string, parts ...string) bool {
	c.lock.Lock()
	defer c.lock.Unlock()
	pa, ok := c.pending[token]
	if !ok {
		return false
	}
	delete(c.pending, token)
	return time.Now().Before(pa.expires) && pa.fingerprint == fingerprint(parts...)
}

// --- auditoría ---

type Auditor struct {
	lock sync.Mutex
	path string
}

func MakeAuditor(path string) *Auditor {
	return &Auditor{path: path}
}

func (a *Auditor) Log(tool string, env string, detail string, decision string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := map[string]any{
		"ts":       time.Now().Format(time.RFC3339),
		"tool":     tool,
		"env":      env,
		"detail":   detail,
		"decision": decision,
	}
	line, _ := json.Marshal(rec)
	f, err := os.OpenFile(a.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}
