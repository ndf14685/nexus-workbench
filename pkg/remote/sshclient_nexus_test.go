// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// El servidor de una Raspberry Pi ofrece keyboard-interactive antes que
// password: si ese método no usa la contraseña guardada, el usuario la ve pedir
// igual (o ve el diálogo de la clave) y parece que la configuración no tomó.
func TestKbdInteractiveUsesStoredPassword(t *testing.T) {
	challenge := createInteractiveKbdInteractiveChallenge(context.Background(), "pi@rpi", utilfn.Ptr("s3cr3t"), nil)
	answers, err := challenge("", "", []string{"Password: "}, []bool{false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(answers) != 1 || answers[0] != "s3cr3t" {
		t.Fatalf("expected the stored password, got %v", answers)
	}
}

func TestKbdInteractiveWithoutStoredPasswordPrompts(t *testing.T) {
	ctx, cancelFn := context.WithCancel(context.Background())
	cancelFn()
	challenge := createInteractiveKbdInteractiveChallenge(ctx, "pi@rpi", nil, &ConnectionDebugInfo{})
	if _, err := challenge("", "", []string{"Password: "}, []bool{false}); err == nil {
		t.Fatal("expected the cancelled prompt to fail instead of answering by itself")
	}
}

// Un segundo factor NO se responde con la contraseña: se sigue preguntando.
func TestKbdInteractiveDoesNotAnswerSecondFactor(t *testing.T) {
	ctx, cancelFn := context.WithCancel(context.Background())
	cancelFn()
	challenge := createInteractiveKbdInteractiveChallenge(ctx, "pi@rpi", utilfn.Ptr("s3cr3t"), &ConnectionDebugInfo{})
	if _, err := challenge("", "", []string{"Verification code: "}, []bool{false}); err == nil {
		t.Fatal("expected the 2FA question to be prompted, not auto-answered")
	}
}

// Una pregunta con echo es visible (usuario, token impreso): tampoco se
// responde sola aunque diga "password".
func TestKbdInteractiveDoesNotAnswerEchoedQuestion(t *testing.T) {
	ctx, cancelFn := context.WithCancel(context.Background())
	cancelFn()
	challenge := createInteractiveKbdInteractiveChallenge(ctx, "pi@rpi", utilfn.Ptr("s3cr3t"), &ConnectionDebugInfo{})
	if _, err := challenge("", "", []string{"password hint: "}, []bool{true}); err == nil {
		t.Fatal("expected an echoed question to be prompted, not auto-answered")
	}
}
