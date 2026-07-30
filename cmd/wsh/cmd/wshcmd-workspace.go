// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var workspaceCommand = &cobra.Command{
	Use:   "workspace",
	Short: "Manage workspaces",
	// Args:    cobra.MinimumNArgs(1),
}

var workspaceCreateName string
var workspaceCreateIcon string
var workspaceCreateColor string
var workspaceCreateTabName string
var workspaceCreateJson string

func init() {
	workspaceCommand.AddCommand(workspaceListCommand)
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateName, "name", "", "workspace name")
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateIcon, "icon", "", "workspace icon")
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateColor, "color", "", "workspace color")
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateTabName, "tabname", "", "name for the initial tab")
	workspaceCreateCommand.Flags().StringVar(&workspaceCreateJson, "json", "", "full definition as JSON (file path, or \"-\" for stdin); flags override its fields")
	workspaceCommand.AddCommand(workspaceCreateCommand)
	rootCmd.AddCommand(workspaceCommand)
}

var workspaceListCommand = &cobra.Command{
	Use:     "list",
	Short:   "List workspaces",
	Run:     workspaceListRun,
	PreRunE: preRunSetupRpcClient,
}

var workspaceCreateCommand = &cobra.Command{
	Use:     "create",
	Short:   "Create a workspace (Nexus Workbench: declarative import)",
	RunE:    workspaceCreateRun,
	PreRunE: preRunSetupRpcClient,
}

func workspaceCreateRun(cmd *cobra.Command, args []string) error {
	var data wshrpc.CommandWorkspaceCreateData
	if workspaceCreateJson != "" {
		var raw []byte
		var err error
		if workspaceCreateJson == "-" {
			raw, err = io.ReadAll(os.Stdin)
		} else {
			raw, err = os.ReadFile(workspaceCreateJson)
		}
		if err != nil {
			return err
		}
		if err = json.Unmarshal(raw, &data); err != nil {
			return err
		}
	}
	if workspaceCreateName != "" {
		data.Name = workspaceCreateName
	}
	if workspaceCreateIcon != "" {
		data.Icon = workspaceCreateIcon
	}
	if workspaceCreateColor != "" {
		data.Color = workspaceCreateColor
	}
	if workspaceCreateTabName != "" {
		data.TabName = workspaceCreateTabName
	}
	workspaceId, err := wshclient.WorkspaceCreateCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 5000})
	if err != nil {
		return err
	}
	WriteStdout("%s\n", workspaceId)
	return nil
}

func workspaceListRun(cmd *cobra.Command, args []string) {
	workspaces, err := wshclient.WorkspaceListCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		WriteStderr("Unable to list workspaces: %v\n", err)
		return
	}

	WriteStdout("[\n")
	for i, w := range workspaces {
		WriteStdout("  {\n    \"windowId\": \"%s\",\n", w.WindowId)
		WriteStderr("    \"workspaceId\": \"%s\",\n", w.WorkspaceData.OID)
		WriteStdout("    \"name\": \"%s\",\n", w.WorkspaceData.Name)
		WriteStdout("    \"icon\": \"%s\",\n", w.WorkspaceData.Icon)
		WriteStdout("    \"color\": \"%s\"\n", w.WorkspaceData.Color)
		if i < len(workspaces)-1 {
			WriteStdout("  },\n")
		} else {
			WriteStdout("  }\n")
		}
	}
	WriteStdout("]\n")
}
