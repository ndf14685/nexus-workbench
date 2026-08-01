// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"reflect"
	"testing"
)

// El administrador de conexiones escribe nexus:environments vía SetConfigCommand.
// El valor llega decodificado de JSON como []any, nunca como []NexusEnvType, así
// que la comparación exacta de tipos lo rechazaba: "invalid value type".
func TestConvertJsonCompositeEnvironments(t *testing.T) {
	ctype := getConfigKeyType("nexus:environments")
	if ctype == nil {
		t.Fatal("nexus:environments no está declarado en SettingsType")
	}
	var decoded any
	raw := `[{"id":"rig","name":"Rig Ubuntu","kind":"ssh","conn":"ndf@192.0.2.10","user":"ndf"}]`
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if reflect.TypeOf(decoded) == ctype {
		t.Fatal("el test no reproduce el caso real: los tipos ya coinciden")
	}
	converted, err := convertJsonComposite(decoded, ctype)
	if err != nil {
		t.Fatalf("convertJsonComposite: %v", err)
	}
	if reflect.TypeOf(converted) != ctype {
		t.Fatalf("tipo convertido = %T, esperado %s", converted, ctype)
	}
	envs, ok := converted.([]NexusEnvType)
	if !ok || len(envs) != 1 {
		t.Fatalf("conversión inesperada: %#v", converted)
	}
	if envs[0].Id != "rig" || envs[0].Conn != "ndf@192.0.2.10" {
		t.Fatalf("campos perdidos en la conversión: %#v", envs[0])
	}
}

func TestConvertJsonCompositeRejectsBadShape(t *testing.T) {
	ctype := getConfigKeyType("nexus:environments")
	if _, err := convertJsonComposite("no soy una lista", ctype); err == nil {
		t.Fatal("una forma inválida debe fallar, no persistirse")
	}
}
