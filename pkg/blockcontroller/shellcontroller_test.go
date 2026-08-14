// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCreateCmdStrAndOptsKeepsTildeForRemoteConn(t *testing.T) {
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_Cmd:    "echo hi",
		waveobj.MetaKey_CmdCwd: "~/workspace",
	}
	_, cmdOpts, err := createCmdStrAndOpts("b-1", meta, "rig3060")
	if err != nil {
		t.Fatalf("remote: %v", err)
	}
	if cmdOpts.Cwd != "~/workspace" {
		t.Fatalf("remote cwd = %q, quería ~/workspace intacto", cmdOpts.Cwd)
	}

	_, cmdOpts, err = createCmdStrAndOpts("b-1", meta, "")
	if err != nil {
		t.Fatalf("local: %v", err)
	}
	if strings.HasPrefix(cmdOpts.Cwd, "~") {
		t.Fatalf("local cwd = %q, quería el ~ expandido", cmdOpts.Cwd)
	}
}
