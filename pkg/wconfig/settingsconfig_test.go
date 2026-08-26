// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Un valor estructurado llega desde el cliente como []interface{}. Antes se lo
// comparaba con el tipo declarado y nunca matcheaba, asi que ninguna clave que
// no fuera escalar se podia escribir: el toggle de "Yoshi Vision" (el control
// que concede o revoca la observacion por IA) fallaba siempre, en silencio.
func TestValidateStructuredValueAcceptsGenericJson(t *testing.T) {
	raw := `[{"id":"webcam-c920","type":"uvc","label":"Webcam",
	          "device":{"name":"HD Pro Webcam C920","vid":"046d","pid":"082d"},
	          "aivision":"changes"}]`
	var val any
	if err := json.Unmarshal([]byte(raw), &val); err != nil {
		t.Fatalf("json invalido en el test: %v", err)
	}
	ctype := getConfigKeyType("nexus:visualsources")
	if ctype == nil {
		t.Fatal("nexus:visualsources no esta declarada en SettingsType")
	}
	if reflect.TypeOf(val) == ctype {
		t.Fatal("el test perderia sentido: el tipo generico ya coincide")
	}
	if !isStructuredKind(ctype.Kind()) {
		t.Fatalf("se esperaba una clave estructurada, es %s", ctype.Kind())
	}
	if err := validateStructuredValue(val, ctype); err != nil {
		t.Fatalf("un valor valido fue rechazado: %v", err)
	}
}

// Validar no es aceptar cualquier cosa: un tipo equivocado sigue siendo error.
func TestValidateStructuredValueRejectsWrongShape(t *testing.T) {
	ctype := getConfigKeyType("nexus:visualsources")
	cases := map[string]string{
		"un objeto donde va una lista":  `{"id":"webcam"}`,
		"un campo con el tipo cambiado": `[{"id":"webcam","width":"mil"}]`,
		"una lista de strings":          `["webcam"]`,
	}
	for name, raw := range cases {
		var val any
		if err := json.Unmarshal([]byte(raw), &val); err != nil {
			t.Fatalf("%s: json invalido en el test: %v", name, err)
		}
		if err := validateStructuredValue(val, ctype); err == nil {
			t.Errorf("%s: se acepto un valor que no encaja", name)
		}
	}
}

// Las claves escalares siguen por el camino de siempre.
func TestScalarKeysAreNotStructured(t *testing.T) {
	for _, key := range []string{"nexus:brainurl", "term:fontsize", "term:disablewebgl"} {
		ctype := getConfigKeyType(key)
		if ctype == nil {
			t.Fatalf("%s no esta declarada", key)
		}
		if isStructuredKind(ctype.Kind()) {
			t.Errorf("%s (%s) no deberia tratarse como estructurada", key, ctype.Kind())
		}
	}
}
