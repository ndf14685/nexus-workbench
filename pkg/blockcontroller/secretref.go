// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/secretstore"
)

// Referencia a un secreto dentro de un valor de cmd:env. Permite declarar en un
// catálogo versionable qué credencial usa cada ambiente sin que el valor viva
// nunca en el archivo: se resuelve acá, contra el almacén cifrado, recién en el
// momento de spawnear el proceso. Así el valor no pasa por una línea de
// comando (visible en ps), ni por el servidor MCP, ni por la auditoría.
//
// El nombre admitido es el mismo que valida el almacén (secretstore.SecretNamePattern):
// referenciar algo que no se puede guardar sería una promesa vacía.
var secretRefPattern = regexp.MustCompile(`\$\{secret:([A-Za-z][A-Za-z0-9_]*)\}`)

// lookupSecret se aísla en una variable para poder testear la resolución sin el
// almacén real, que se inicializa contra safeStorage de Electron.
var lookupSecret = secretstore.GetSecret

// SecretRefNames devuelve los secretos referenciados por un valor.
func SecretRefNames(value string) []string {
	matches := secretRefPattern.FindAllStringSubmatch(value, -1)
	if matches == nil {
		return nil
	}
	names := make([]string, 0, len(matches))
	for _, m := range matches {
		names = append(names, m[1])
	}
	return names
}

// resolveSecretRefs reemplaza las referencias por su valor. Un secreto que no
// existe es un error y no un string vacío: dejar arrancar el proceso con la
// credencial en blanco es peor que no arrancarlo, porque el comando corre igual
// contra el destino real, sin autenticación o con la identidad equivocada.
func resolveSecretRefs(value string) (string, error) {
	if !strings.Contains(value, "${secret:") {
		return value, nil
	}
	var problems []string
	out := secretRefPattern.ReplaceAllStringFunc(value, func(match string) string {
		name := secretRefPattern.FindStringSubmatch(match)[1]
		secret, ok, err := lookupSecret(name)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s (%v)", name, err))
			return match
		}
		if !ok {
			problems = append(problems, fmt.Sprintf("%s (no está en el almacén; cargalo con 'wsh secret set %s')", name, name))
			return match
		}
		return secret
	})
	if len(problems) > 0 {
		return "", fmt.Errorf("no se pudo resolver %s", strings.Join(problems, ", "))
	}
	return out, nil
}

// ResolveEnvSecretRefs resuelve las referencias de todo el mapa de entorno. El
// almacén se inicializa contra safeStorage de Electron y puede fallar de formas
// que no controlamos; un pánico suyo no puede tumbar el spawn del bloque, pero
// tampoco puede dejarlo arrancar con la credencial vacía.
func ResolveEnvSecretRefs(env map[string]string) (rtn map[string]string, rtnErr error) {
	defer func() {
		if r := recover(); r != nil {
			rtn, rtnErr = nil, fmt.Errorf("el almacén de secretos no está disponible: %v", r)
		}
	}()
	for key, value := range env {
		resolved, err := resolveSecretRefs(value)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", key, err)
		}
		env[key] = resolved
	}
	return env, nil
}
