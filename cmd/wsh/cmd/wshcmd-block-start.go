// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// el controller de un bloque lo arranca normalmente el frontend al renderizar
// la vista term; los bloques headless (parkeados de nacimiento) o los creados
// con la UI cerrada no tienen quién lo dispare — este comando lo hace
// server-side
var blockStartCmd = &cobra.Command{
	Use:                   "start [blockid]",
	Short:                 "start a block's controller server-side (for headless blocks or with the UI closed)",
	Args:                  cobra.ExactArgs(1),
	RunE:                  blockStartRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

func init() {
	blockCmd.AddCommand(blockStartCmd)
}

func blockStartRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("block:start", rtnErr == nil)
	}()
	blockId, err := resolveBlockIdArg(args[0])
	if err != nil {
		return err
	}
	tabId := os.Getenv("WAVETERM_TABID")
	if tabId == "" {
		return fmt.Errorf("no tab id specified (set WAVETERM_TABID environment variable)")
	}
	err = wshclient.ControllerResyncCommand(RpcClient, wshrpc.CommandControllerResyncData{
		TabId:   tabId,
		BlockId: blockId,
	}, &wshrpc.RpcOpts{Timeout: 10000})
	if err != nil {
		return fmt.Errorf("starting block controller: %w", err)
	}
	WriteStdout("block controller started\n")
	return nil
}
