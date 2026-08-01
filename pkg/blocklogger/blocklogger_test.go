// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package blocklogger

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func drainOne(t *testing.T) wshrpc.CommandControllerAppendOutputData {
	t.Helper()
	select {
	case data := <-outputChan:
		return data
	default:
		t.Fatal("expected output queued, got none")
		return wshrpc.CommandControllerAppendOutputData{}
	}
}

func decode(t *testing.T, data wshrpc.CommandControllerAppendOutputData) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(data.Data64)
	if err != nil {
		t.Fatalf("bad base64: %v", err)
	}
	return string(raw)
}

// A hard failure has to reach the terminal even when the block has no
// term:conndebug set, which is the default. Infof (verbose progress) must stay
// gated: that is the distinction the fix relies on.
func TestWriteErrorfIsNotGatedOnConnDebug(t *testing.T) {
	outputChan = make(chan wshrpc.CommandControllerAppendOutputData, 8)
	defer func() { outputChan = nil }()

	ctx := context.Background()

	Infof(ctx, "connecting to %s\n", "host")
	Debugf(ctx, "swaptoken %s\n", "abc")
	if len(outputChan) != 0 {
		t.Fatalf("expected no output without a log context, got %d", len(outputChan))
	}

	WriteErrorf("block-1", "error running shell: %v\n", errors.New("connection error: auth failed"))
	if len(outputChan) != 1 {
		t.Fatalf("expected 1 queued output, got %d", len(outputChan))
	}
	data := drainOne(t)
	if data.BlockId != "block-1" {
		t.Fatalf("wrong blockid: %q", data.BlockId)
	}
	got := decode(t, data)
	want := "error running shell: connection error: auth failed\r\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestWriteErrorfWithoutBlockIdIsNoop(t *testing.T) {
	outputChan = make(chan wshrpc.CommandControllerAppendOutputData, 8)
	defer func() { outputChan = nil }()

	WriteErrorf("", "error running shell: %v\n", errors.New("boom"))
	if len(outputChan) != 0 {
		t.Fatalf("expected no output for an empty blockid, got %d", len(outputChan))
	}
}

// The gated path still works when the block does ask for connection debugging.
func TestInfofStillWritesWithLogContext(t *testing.T) {
	outputChan = make(chan wshrpc.CommandControllerAppendOutputData, 8)
	defer func() { outputChan = nil }()

	ctx := ContextWithLogBlockId(context.Background(), "block-2", false)
	Infof(ctx, "[conndebug] hello\n")
	Debugf(ctx, "[conndebug] verbose only\n")
	if len(outputChan) != 1 {
		t.Fatalf("expected only the Infof line (Debugf needs verbose), got %d", len(outputChan))
	}
	if got, want := decode(t, drainOne(t)), "[conndebug] hello\r\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
