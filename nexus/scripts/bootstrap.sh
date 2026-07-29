#!/usr/bin/env bash
# Nexus Workbench — bootstrap del entorno de desarrollo (Linux/macOS/WSL).
# En Windows nativo usá PowerShell siguiendo nexus/docs/WINDOWS_BUILD.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== Nexus Workbench bootstrap =="

command -v node >/dev/null || { echo "FALTA: node 22+ (https://nodejs.org)"; exit 1; }
command -v npm >/dev/null || { echo "FALTA: npm"; exit 1; }

if ! command -v go >/dev/null; then
    if [ -x "$HOME/.local/nexus-toolchain/go/bin/go" ]; then
        export PATH="$HOME/.local/nexus-toolchain/go/bin:$PATH"
    else
        echo "FALTA: go 1.25+ — instalable con:"
        echo "  mkdir -p ~/.local/nexus-toolchain && cd ~/.local/nexus-toolchain \\"
        echo "    && curl -fsSL https://go.dev/dl/go1.25.12.linux-amd64.tar.gz | tar -xz"
        exit 1
    fi
fi

if ! command -v zig >/dev/null && [ -x "$HOME/.local/nexus-toolchain/zig/zig" ]; then
    export PATH="$HOME/.local/nexus-toolchain/zig:$PATH"
fi
command -v zig >/dev/null || { echo "FALTA: zig (CC para build:server) — https://ziglang.org/download"; exit 1; }

if ! command -v task >/dev/null; then
    if [ -x "$HOME/.local/nexus-toolchain/taskbin/task" ]; then
        export PATH="$HOME/.local/nexus-toolchain/taskbin:$PATH"
    else
        echo "FALTA: task — https://taskfile.dev/installation (binario único)"
        exit 1
    fi
fi

echo "-- node $(node --version) / go $(go version | awk '{print $3}') / task $(task --version)"

echo "-- npm install"
npm install --no-audit --no-fund

echo "-- go mod download"
go mod download

echo "-- generate (schema + bindings TS/Go)"
task generate

echo "-- backend (wavesrv + wsh)"
task build:backend

echo ""
echo "OK. Para correr la app en desarrollo:  task dev"
echo "Para validar el árbol:                 nexus/scripts/verify.sh"
