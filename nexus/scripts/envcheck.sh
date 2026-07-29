#!/usr/bin/env bash
# Nexus Workbench — diagnóstico del entorno de desarrollo.
set -uo pipefail
cd "$(dirname "$0")/../.."
[ -x "$HOME/.local/nexus-toolchain/go/bin/go" ] && export PATH="$HOME/.local/nexus-toolchain/go/bin:$PATH"
[ -x "$HOME/.local/nexus-toolchain/taskbin/task" ] && export PATH="$HOME/.local/nexus-toolchain/taskbin:$PATH"
[ -x "$HOME/.local/nexus-toolchain/zig/zig" ] && export PATH="$HOME/.local/nexus-toolchain/zig:$PATH"

echo "== Nexus Workbench envcheck =="
echo "repo:      $(pwd)"
echo "branch:    $(git branch --show-current) @ $(git rev-parse --short HEAD)"
echo "baseline:  $(git tag -l 'wave-baseline/*' | sort -V | tail -1)"
echo "remotos:"
git remote -v | sed 's/^/  /'
echo ""
for tool in node npm go task zig git; do
    if command -v $tool >/dev/null 2>&1; then
        case $tool in
            node) v=$(node --version) ;;
            npm) v=$(npm --version) ;;
            go) v=$(go version | awk '{print $3}') ;;
            task) v=$(task --version 2>/dev/null | head -1) ;;
            zig) v=$(zig version) ;;
            git) v=$(git --version | awk '{print $3}') ;;
        esac
        echo "OK    $tool $v"
    else
        extra=""
        [ "$tool" = "zig" ] && extra="  (requerido como CC para task build:server/package)"
        echo "FALTA $tool$extra"
    fi
done
echo ""
echo "node_modules: $([ -d node_modules ] && echo presente || echo 'FALTA (correr npm install)')"
echo "dist/bin:     $(ls dist/bin 2>/dev/null | head -3 | tr '\n' ' ' || echo 'sin binarios (correr task build:backend)')"
echo "config dir:   ${WAVETERM_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/waveterm}"
