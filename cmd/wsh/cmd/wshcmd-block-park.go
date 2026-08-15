// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var blockCmd = &cobra.Command{
	Use:   "block",
	Short: "manage blocks",
}

var blockParkCmd = &cobra.Command{
	Use:                   "park [blockid]",
	Short:                 "park a block (remove it from the layout, keep it running)",
	Args:                  cobra.ExactArgs(1),
	RunE:                  blockParkRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var blockUnparkCmd = &cobra.Command{
	Use:                   "unpark [blockid]",
	Short:                 "unpark a block back into a tab layout",
	Args:                  cobra.ExactArgs(1),
	RunE:                  blockUnparkRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var (
	blockParkNote  string
	blockUnparkTab string
)

func init() {
	rootCmd.AddCommand(blockCmd)
	blockCmd.AddCommand(blockParkCmd)
	blockCmd.AddCommand(blockUnparkCmd)
	blockParkCmd.Flags().StringVar(&blockParkNote, "note", "", "note stored with the parked block")
	blockUnparkCmd.Flags().StringVar(&blockUnparkTab, "tab", "", "tab id to unpark the block into")
}

func resolveBlockIdArg(arg string) (string, error) {
	fullORef, err := resolveSimpleId(arg)
	if err != nil {
		return "", fmt.Errorf("resolving blockid: %w", err)
	}
	if fullORef.OType != "block" {
		return "", fmt.Errorf("object reference is not a block")
	}
	return fullORef.OID, nil
}

func blockParkRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("block:park", rtnErr == nil)
	}()
	blockId, err := resolveBlockIdArg(args[0])
	if err != nil {
		return err
	}
	err = wshclient.ParkBlockCommand(RpcClient, wshrpc.CommandParkBlockData{
		BlockId: blockId,
		Note:    blockParkNote,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("park block failed: %w", err)
	}
	WriteStdout("block parked\n")
	return nil
}

func blockUnparkRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("block:unpark", rtnErr == nil)
	}()
	blockId, err := resolveBlockIdArg(args[0])
	if err != nil {
		return err
	}
	tabId, err := wshclient.UnparkBlockCommand(RpcClient, wshrpc.CommandUnparkBlockData{
		BlockId: blockId,
		TabId:   blockUnparkTab,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("unpark block failed: %w", err)
	}
	WriteStdout("block unparked into tab %s\n", tabId)
	return nil
}
