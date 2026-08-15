// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var runtimeCmd = &cobra.Command{
	Use:   "runtime",
	Short: "manage the nexus runtime (detached wavesrv)",
}

var runtimeStatusCmd = &cobra.Command{
	Use:                   "status",
	Short:                 "show runtime version and connectivity",
	Args:                  cobra.NoArgs,
	RunE:                  runtimeStatusRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var runtimeStopCmd = &cobra.Command{
	Use:                   "stop",
	Short:                 "gracefully shut down the runtime (terminals will stop)",
	Args:                  cobra.NoArgs,
	RunE:                  runtimeStopRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var runtimeStopReason string

func init() {
	rootCmd.AddCommand(runtimeCmd)
	runtimeCmd.AddCommand(runtimeStatusCmd)
	runtimeCmd.AddCommand(runtimeStopCmd)
	runtimeStopCmd.Flags().StringVar(&runtimeStopReason, "reason", "", "reason recorded in the runtime log")
}

func runtimeStatusRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("runtime:status", rtnErr == nil)
	}()
	info, err := wshclient.WaveInfoCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("runtime not reachable: %w", err)
	}
	WriteStdout("runtime ok\n")
	WriteStdout("  version:   %s (build %s)\n", info.Version, info.BuildTime)
	WriteStdout("  data dir:  %s\n", info.DataDir)
	WriteStdout("  config:    %s\n", info.ConfigDir)
	return nil
}

func runtimeStopRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("runtime:stop", rtnErr == nil)
	}()
	reason := runtimeStopReason
	if reason == "" {
		reason = "wsh runtime stop"
	}
	err := wshclient.ShutdownRuntimeCommand(RpcClient, wshrpc.CommandShutdownRuntimeData{Reason: reason}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("shutdown request failed: %w", err)
	}
	WriteStdout("runtime shutdown requested\n")
	return nil
}
