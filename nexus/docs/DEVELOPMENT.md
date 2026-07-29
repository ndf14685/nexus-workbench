# Nexus Workbench — Desarrollo

## Requisitos

- Node 22+ y npm 10+
- Go 1.25+ (`go.mod` exige 1.25.6)
- [Task](https://taskfile.dev) 3.x
- Zig (el Taskfile lo usa como compilador C para `wavesrv` — cgo/sqlite —
  incluso en builds nativos Linux/Windows)
- En esta máquina Linux el toolchain está en `~/.local/nexus-toolchain/`
  (`go/bin`, `taskbin` y `zig`); `nexus/scripts/*.sh` lo agregan al PATH solos.

## Setup y ejecución

```bash
nexus/scripts/envcheck.sh      # diagnóstico del entorno
nexus/scripts/bootstrap.sh     # npm install + go mod download + generate + backend
task dev                       # app Electron en modo desarrollo (HMR)
```

`task dev` compila `wavesrv` + `wsh`, levanta electron-vite y abre la app.
En desarrollo la config vive en `~/.config/waveterm-dev/` y NO corre el
auto-updater.

## Validación

```bash
nexus/scripts/verify.sh        # vet + tests Go + tsc + vitest + build FE + secretos + branding
```

Comandos individuales: `go vet ./...` · `go test ./...` · `npx tsc --noEmit` ·
`npx vitest run` · `npx eslint .` · `task check:ts`.

## Configuración propia (ambientes)

```bash
cp nexus/config/environments.example.yaml nexus/config/environments.yaml
$EDITOR nexus/config/environments.yaml            # sin credenciales, solo alias
node nexus/scripts/import-environments.mjs --dry-run
node nexus/scripts/import-environments.mjs        # (--dev para la config de desarrollo)
```

Resultado:

- **Barra lateral de widgets**: un botón por ambiente (label + icono + color
  por clase) — click = terminal nueva en esa conexión. Es el equivalente a la
  lista de conexiones guardadas de WinSSHterm. Solo se gestionan las claves
  `nexus-env-*` de `widgets.json`; los widgets propios se preservan.
- **Selector de conexiones** (`Ctrl/Cmd-G`): los ambientes ssh/wsl con tema de
  terminal según su clase (prod=warmyellow, work=campbell, lab=dracula,
  personal=default-dark).
- **Fondos de tab** `Nexus: <clase>` en el menú contextual del tab →
  Backgrounds, para marcar tabs por ambiente.

SSH: Wave lee `~/.ssh/config` directamente; los `host:` del catálogo deben
ser alias definidos allí. La autenticación es de ssh-agent/claves nativas.

## Reglas del repo

- Cambios propios: ramas `feature/*` → `develop`; `main` es estable.
- No editar archivos generados (`frontend/types/gotypes.d.ts`,
  `frontend/app/store/wshclientapi.ts`); modificar Go + `task generate`.
- Convenciones de código: ver `CLAUDE.md` / `.kilocode/rules/rules.md`.
- Docs propias en `nexus/docs/` (NO en `docs/`, que es el Docusaurus de Wave).
- Sync upstream: `nexus/docs/UPSTREAM_SYNC.md`.
- Empaquetado Windows: `nexus/docs/WINDOWS_BUILD.md`.
