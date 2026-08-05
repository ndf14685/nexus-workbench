// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Runbooks: los comandos favoritos del catálogo, ejecutables con parámetros.
// Hasta ahora sólo se generaban widgets para los comandos sin placeholders y no
// destructivos; el resto había que copiarlos y completarlos a mano. Acá se
// resuelven los placeholders con validación, se puede pedir un dry-run que
// muestra el comando final sin ejecutarlo, y la ejecución pasa por el mismo
// gate de confirmación que run_command.
package main

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Placeholder del catálogo: <service>, <container>, <namespace>.
var placeholderPattern = regexp.MustCompile(`<([a-zA-Z][a-zA-Z0-9_-]*)>`)

// Un valor de parámetro no puede introducir estructura de shell: el runbook lo
// escribe el usuario, pero quien lo invoca con parámetros puede ser un agente.
var unsafeParamPattern = regexp.MustCompile("[;&|`$><\\n\\r\\\\]|\\$\\(|\\|\\|")

type Runbook struct {
	Id          string   `yaml:"id" json:"id"`
	Name        string   `yaml:"name" json:"name"`
	Command     string   `yaml:"command" json:"command"`
	Tags        []string `yaml:"tags,omitempty" json:"tags,omitempty"`
	Destructive bool     `yaml:"destructive,omitempty" json:"destructive,omitempty"`
	Environment string   `yaml:"environment,omitempty" json:"environment,omitempty"`
}

type RunbookCatalog struct {
	Version  int       `yaml:"version"`
	Commands []Runbook `yaml:"commands"`
}

func LoadRunbooks(path string) (*RunbookCatalog, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("leyendo runbooks %s: %w", path, err)
	}
	var cat RunbookCatalog
	if err := yaml.Unmarshal(raw, &cat); err != nil {
		return nil, fmt.Errorf("parseando %s: %w", path, err)
	}
	if cat.Version != 1 {
		return nil, fmt.Errorf("runbooks %s: version debe ser 1", path)
	}
	return &cat, nil
}

func (c *RunbookCatalog) Get(id string) (*Runbook, error) {
	for i := range c.Commands {
		if c.Commands[i].Id == id {
			return &c.Commands[i], nil
		}
	}
	return nil, fmt.Errorf("runbook %q no está en el catálogo (usar list_runbooks)", id)
}

// RunbookParams devuelve los placeholders que el runbook espera, ordenados y
// sin repetir.
func RunbookParams(command string) []string {
	matches := placeholderPattern.FindAllStringSubmatch(command, -1)
	seen := map[string]bool{}
	var names []string
	for _, m := range matches {
		if seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		names = append(names, m[1])
	}
	sort.Strings(names)
	return names
}

// ValidateParamValue rechaza valores que cambiarían la forma del comando.
func ValidateParamValue(name string, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("el parámetro %q está vacío", name)
	}
	if unsafeParamPattern.MatchString(value) {
		return fmt.Errorf("el valor de %q contiene metacaracteres de shell; un parámetro sólo puede ser un nombre, no un comando", name)
	}
	return nil
}

// ResolveRunbook sustituye los placeholders y devuelve el comando final. Un
// parámetro faltante es un error: ejecutar "systemctl restart <service>" con el
// placeholder crudo fallaría de una forma mucho menos clara.
func ResolveRunbook(rb *Runbook, params map[string]string) (string, error) {
	needed := RunbookParams(rb.Command)
	var missing []string
	for _, name := range needed {
		value, ok := params[name]
		if !ok {
			missing = append(missing, name)
			continue
		}
		if err := ValidateParamValue(name, value); err != nil {
			return "", err
		}
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("faltan parámetros: %s", strings.Join(missing, ", "))
	}
	for _, name := range unknownParams(needed, params) {
		return "", fmt.Errorf("el runbook %q no acepta el parámetro %q (espera: %s)", rb.Id, name, strings.Join(needed, ", "))
	}
	resolved := rb.Command
	for _, name := range needed {
		resolved = strings.ReplaceAll(resolved, "<"+name+">", params[name])
	}
	return resolved, nil
}

func unknownParams(needed []string, params map[string]string) []string {
	valid := map[string]bool{}
	for _, n := range needed {
		valid[n] = true
	}
	var extra []string
	for name := range params {
		if !valid[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	return extra
}
