#!/usr/bin/env bash
# Nexus Workbench — verificación integral del árbol (usada a mano y en CI y
# en cada sync de upstream). No empaqueta; valida compilación, tests y seguridad.
set -uo pipefail
cd "$(dirname "$0")/../.."

[ -x "$HOME/.local/nexus-toolchain/go/bin/go" ] && export PATH="$HOME/.local/nexus-toolchain/go/bin:$PATH"
[ -x "$HOME/.local/nexus-toolchain/taskbin/task" ] && export PATH="$HOME/.local/nexus-toolchain/taskbin:$PATH"

FAIL=0
step() { echo ""; echo "== $1"; }
check() { if [ "$2" -eq 0 ]; then echo "-- OK: $1"; else echo "-- FALLÓ: $1"; FAIL=1; fi; }

step "go vet (compila todo el backend)"
go vet ./... ; check "go vet" $?

step "go test"
go test ./... > /tmp/nexus-gotest.log 2>&1
check "go test" $?
grep -E '^(FAIL|ok  )' /tmp/nexus-gotest.log | grep FAIL || true

step "typecheck TS"
npx tsc --noEmit ; check "tsc --noEmit" $?

step "tests frontend (vitest)"
npx vitest run --reporter=dot > /tmp/nexus-vitest.log 2>&1
check "vitest" $?
tail -5 /tmp/nexus-vitest.log

step "build frontend (electron-vite, modo development)"
npx electron-vite build --mode development > /tmp/nexus-febuild.log 2>&1
check "electron-vite build" $?

step "chequeo de secretos versionados"
SECRETS=$(git grep -nIiE '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16})' -- ':!node_modules' ':!*.lock' || true)
if [ -n "$SECRETS" ]; then echo "$SECRETS"; check "sin secretos" 1; else check "sin secretos" 0; fi

step "config real no versionada"
git ls-files --error-unmatch nexus/config/environments.yaml >/dev/null 2>&1 && check "environments.yaml fuera de git" 1 || check "environments.yaml fuera de git" 0

step "branding"
grep -q '"productName": "Nexus Workbench"' package.json ; check "productName" $?
# D-013: el feed de updates es GitHub Releases del fork (reemplazó al placeholder .invalid de D-004)
grep -q 'owner: "ndf14685"' electron-builder.config.cjs && ! grep -q 'waveterm\.dev' electron-builder.config.cjs
check "feed de updates propio (no Wave)" $?
# D-026: autoupdate pasa a ON, así que lo que hay que proteger ya no es el flag
# sino que el feed sea NUESTRA release gobernada (owner + repo), no otra.
grep -q 'repo: "nexus-workbench"' electron-builder.config.cjs ; check "repo del feed de updates" $?
grep -q '"telemetry:enabled": false' pkg/wconfig/defaultconfig/settings.json ; check "telemetry default off" $?

step "npm audit (informativo, no bloquea)"
npm audit --omit=dev 2>&1 | tail -3 || true

echo ""
if [ "$FAIL" -eq 0 ]; then echo "== VERIFY: TODO OK =="; else echo "== VERIFY: HAY FALLOS (ver arriba) =="; fi
exit $FAIL
