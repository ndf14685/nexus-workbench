// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Nexus extension: CLI wrapper for ControllerInputCommand so external agents
// (nexus-workbench-mcp jarvis-agent) can inject input into a terminal block.

package cmd

import (
	"encoding/base64"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var inputData string
var inputData64 string

var inputCmd = &cobra.Command{
	Use:     "input -b {blockid|blocknum|this} (--data text | --data64 base64)",
	Short:   "send input to a terminal block",
	Args:    cobra.NoArgs,
	RunE:    inputRun,
	PreRunE: preRunSetupRpcClient,
	Hidden:  true,
}

func init() {
	inputCmd.Flags().StringVar(&inputData, "data", "", "raw input text (use \\n for enter)")
	inputCmd.Flags().StringVar(&inputData64, "data64", "", "base64-encoded input bytes")
	rootCmd.AddCommand(inputCmd)
}

func inputRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("input", rtnErr == nil)
	}()
	if inputData == "" && inputData64 == "" {
		return fmt.Errorf("one of --data or --data64 is required")
	}
	if inputData != "" && inputData64 != "" {
		return fmt.Errorf("--data and --data64 are mutually exclusive")
	}
	fullORef, err := resolveBlockArg()
	if err != nil {
		return err
	}
	data64 := inputData64
	if inputData != "" {
		data64 = base64.StdEncoding.EncodeToString([]byte(inputData))
	} else if _, err := base64.StdEncoding.DecodeString(inputData64); err != nil {
		return fmt.Errorf("invalid --data64: %v", err)
	}
	inputData := wshrpc.CommandBlockInputData{
		BlockId:     fullORef.OID,
		InputData64: data64,
	}
	err = wshclient.ControllerInputCommand(RpcClient, inputData, &wshrpc.RpcOpts{Timeout: 5000})
	if err != nil {
		return fmt.Errorf("sending input: %v", err)
	}
	return nil
}
