// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// nexus: expone por wsh la captura de bloque que el motor ya implementa
// (CaptureBlockScreenshotCommand, usada por la tool de screenshot de la AI).
// Existe porque un bloque que tiene tomado un dispositivo exclusivo —una
// capturadora UVC— es el ÚNICO que puede entregar su imagen: cualquier otro
// proceso que intente abrir el device recibe DEVICE_BUSY.
var screenshotCmd = &cobra.Command{
	Use:     "screenshot [-b {blockid|blocknum|this}] [-o archivo]",
	Short:   "capture a block as an image",
	Args:    cobra.NoArgs,
	RunE:    screenshotRun,
	PreRunE: preRunSetupRpcClient,
}

var screenshotOutFile string
var screenshotRaw bool

func init() {
	screenshotCmd.Flags().StringVarP(&screenshotOutFile, "output", "o", "",
		"escribir la imagen (PNG) en este archivo; sin esto sale el data URL por stdout")
	screenshotCmd.Flags().BoolVar(&screenshotRaw, "raw", false,
		"emitir sólo el base64, sin el prefijo data:")
	rootCmd.AddCommand(screenshotCmd)
}

const screenshotTimeoutMs = 8000

func screenshotRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("screenshot", rtnErr == nil)
	}()

	tabId := os.Getenv("WAVETERM_TABID")
	if tabId == "" {
		return fmt.Errorf("no tab id specified (set WAVETERM_TABID environment variable)")
	}
	fullORef, err := resolveBlockArg()
	if err != nil {
		return err
	}
	data, err := wshclient.CaptureBlockScreenshotCommand(RpcClient,
		wshrpc.CommandCaptureBlockScreenshotData{BlockId: fullORef.OID},
		&wshrpc.RpcOpts{Route: fmt.Sprintf("tab:%s", tabId), Timeout: screenshotTimeoutMs})
	if err != nil {
		return fmt.Errorf("capturando el bloque: %v", err)
	}
	if data == "" {
		return fmt.Errorf("el bloque no devolvió imagen (¿la ventana está renderizando?)")
	}
	if screenshotOutFile == "" {
		if screenshotRaw {
			WriteStdout("%s\n", stripDataURLPrefix(data))
			return nil
		}
		WriteStdout("%s\n", data)
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(stripDataURLPrefix(data))
	if err != nil {
		return fmt.Errorf("decodificando la imagen: %v", err)
	}
	if err := os.WriteFile(screenshotOutFile, raw, 0o600); err != nil {
		return fmt.Errorf("escribiendo %s: %v", screenshotOutFile, err)
	}
	return nil
}

func stripDataURLPrefix(data string) string {
	if idx := strings.Index(data, ";base64,"); idx >= 0 {
		return data[idx+len(";base64,"):]
	}
	return data
}
