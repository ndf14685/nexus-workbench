#!/usr/bin/env bash
# Nexus Workbench — detecta releases nuevas de WaveTerm y prepara la rama de sync.
# Uso: nexus/scripts/upstream-check.sh [--start <tag>]
set -euo pipefail
cd "$(dirname "$0")/../.."

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/wavetermdev/waveterm.git
git fetch upstream --tags --quiet

BASELINE=$(git tag -l 'wave-baseline/*' | sort -V | tail -1)
BASELINE_TAG=${BASELINE#wave-baseline/}
echo "baseline actual: ${BASELINE:-<sin tag wave-baseline/*>}"

LATEST=$(git tag -l 'v*' | grep -vE 'beta' | sort -V | tail -1)
LATEST_BETA=$(git tag -l 'v*beta*' | sort -V | tail -1)
echo "última release estable de Wave:  $LATEST"
echo "última beta de Wave:             $LATEST_BETA"
echo "commits de upstream/main no integrados: $(git rev-list --count HEAD..upstream/main)"

if [ "${1:-}" = "--start" ]; then
    TAG=${2:?uso: --start <tag>}
    git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "tag $TAG no existe"; exit 1; }
    BRANCH="upstream-sync/$TAG"
    git checkout -b "$BRANCH" develop
    echo ""
    echo "Rama $BRANCH creada desde develop. Próximos pasos:"
    echo "  1. git merge $TAG"
    echo "  2. resolver conflictos (zonas calientes: ver nexus/docs/UPSTREAM_SYNC.md)"
    echo "  3. nexus/scripts/verify.sh"
    echo "  4. completar nexus/docs/templates/upstream-sync-report.md → nexus/reports/"
    echo "  5. merge a develop; luego aprobación manual a main"
    echo "  6. git tag -f wave-baseline/$TAG $TAG"
fi
