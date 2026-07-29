#!/usr/bin/env bash
# Nexus Workbench — compila el servidor MCP (linux + windows amd64).
set -euo pipefail
cd "$(dirname "$0")/../mcp"
[ -x "$HOME/.local/nexus-toolchain/go/bin/go" ] && export PATH="$HOME/.local/nexus-toolchain/go/bin:$PATH"

OUT=../../dist/nexus-mcp
mkdir -p "$OUT"
echo "== nexus-workbench-mcp (linux/amd64)"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "$OUT/nexus-workbench-mcp" .
echo "== nexus-workbench-mcp (windows/amd64)"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$OUT/nexus-workbench-mcp.exe" .
ls -la "$OUT"
