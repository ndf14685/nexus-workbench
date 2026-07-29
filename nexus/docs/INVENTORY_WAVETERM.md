# Inventario de WaveTerm (evidencia del código)

> Baseline: `wave-baseline/v0.14.5-32-gc99022c1` (upstream/main al 2026-06-19).
> Relevado el 2026-07-28 mediante inspección directa del árbol.

## Estructura del monorepo

| Área | Ruta | Notas |
|---|---|---|
| Electron main | `emain/` | `emain.ts` (appMain), `emain-window.ts`, `emain-platform.ts` (dirs/branding), `updater.ts`, `preload.ts` |
| Frontend React | `frontend/` | entry `frontend/wave.ts`, app en `frontend/app/`, layout tiling en `frontend/layout/` |
| Backend Go | `cmd/`, `pkg/` | `cmd/server` (wavesrv), `cmd/wsh` (CLI), codegen en `cmd/generate{ts,go,schema}` |
| RPC | `pkg/wshrpc/` | `wshrpctypes.go` (interfaz única), `wshserver/`, cliente generado `wshclient/` |
| SSH/conexiones | `pkg/remote/` | `conncontroller/` (SSHConn, keepalive), `connparse/`, `fileshare/` |
| WSL | `pkg/wsl/`, `pkg/wslconn/` | stack paralelo a SSH |
| Terminales | `pkg/blockcontroller/`, `pkg/shellexec/` | pty local/remoto/WSL |
| Persistencia | `pkg/wstore/`, `pkg/filestore/`, `db/` | 2 SQLite, migraciones embebidas |
| Config | `pkg/wconfig/` | settings/connections/presets/widgets JSON + defaults embebidos |
| Objetos | `pkg/waveobj/`, `pkg/wcore/` | client/window/workspace/tab/block/layout |
| Telemetría | `pkg/telemetry/`, `pkg/wcloud/` | endpoints api/ping.waveterm.dev |
| Docs site | `docs/` | Docusaurus independiente (workspace npm); no meter .md sueltos |
| Sub-módulo Go | `tsunami/` | framework de apps VDOM, module separado |
| Build | `Taskfile.yml`, `electron.vite.config.ts`, `electron-builder.config.cjs`, `version.cjs` | |

## Puntos clave verificados

- **Dev app**: `task dev` (= `electron-vite dev` + deps `build:backend`).
- **Package**: `task package` → `npm run build:prod` + `electron-builder` → `make/`.
- **Windows targets**: nsis + msi + zip; firma solo con secretos DigiCert
  (sin ellos, unsigned OK). **No se puede empaquetar Windows desde Linux** con
  el Taskfile actual (`build:server:windows` tiene `platforms: [windows]`);
  la vía es CI `windows-latest` (ver `nexus-windows-package.yml`).
- **Codegen**: tipos TS generados desde Go (`task generate`); no editar
  `frontend/types/gotypes.d.ts` ni `frontend/app/store/wshclientapi.ts`.
- **Autoupdate**: `electron-updater`; feed = `publish.url` horneado en
  `app-update.yml` al empaquetar; gating por settings `autoupdate:*`
  (`emain/updater.ts`). En dev no corre.
- **Telemetría**: `telemetry:enabled` (default upstream: true) → bufferiza en
  SQLite y sube cada 4h a `api.waveterm.dev`; ping diario a
  `ping.waveterm.dev` (kill switch env `WAVETERM_NOPING`).
- **Tests**: 33 archivos `_test.go` (26 paquetes) + 14 archivos vitest.
  Upstream NO tiene CI de tests/lint. `npm test` = vitest.
- **Config dirs**: `WAVETERM_CONFIG_HOME` → `XDG_CONFIG_HOME/waveterm` →
  `~/.config/waveterm` (igual en Windows); data análogo; sufijo `-dev` en
  desarrollo. Legacy `~/.waveterm` si existe `wave.lock`.
- **SSH remoto**: instala `wsh` en `~/.waveterm/bin/wsh` del remoto y levanta
  `wsh connserver`; auth por JWT (`WAVETERM_JWT`).

## Branding: qué se cambió y qué NO

### Cambiado (visible, seguro) — hecho en este fork

| Ítem | Archivo |
|---|---|
| `<title>` | `index.html` |
| `document.title` (3 sitios) | `frontend/wave.ts` |
| `app.setName` visible | `emain/emain-platform.ts` L35 |
| Menú About | `emain/emain-menu.ts` |
| Diálogo de quit | `emain/emain.ts` |
| Notificación del updater | `emain/updater.ts` |
| Modal About (título/tagline/copyright) | `frontend/app/modals/about.tsx` |
| Onboarding headline | `frontend/app/onboarding/onboarding.tsx` |
| `productName`, `description` | `package.json` |
| `artifactName` → `NexusWorkbench-*` | `electron-builder.config.cjs` |
| `publish.url` → `.invalid` | `electron-builder.config.cjs` |
| Defaults autoupdate/telemetry → false | `pkg/wconfig/defaultconfig/settings.json` |

### NO cambiado deliberadamente (motor; alto riesgo)

- `appId dev.commandline.waveterm` (desinstala/huérfana apps instaladas).
- `app.setName("waveterm/electron")` interno (L18) — cache dir de Electron.
- Dirs `waveterm`/`waveterm-dev`, legacy `~/.waveterm`, `wave.lock`.
- Env vars `WAVETERM_*` (24 en Go; contrato Electron↔Go↔wsh remoto).
- `WAVESRV-ESTART` (handshake stderr), rutas RPC `wavesrv`/`electron`.
- Binarios `wavesrv.*`, `wsh-*`; sockets `wave.sock`, `wave-remote.sock`.
- `~/.waveterm/` en hosts remotos (rompería wsh ya instalado en cada server).
- DB `waveterm.db`/`filestore.db` y tablas `db_*` (pérdida de workspaces).
- Iconos (`build/icon.*`, `public/logos/*`, `frontend/app/asset/logo.svg`):
  pendiente de assets propios; hoy se conserva el logo de Wave (backlog).
- Strings menores: "Wave AI", "WaveApp", tooltips, links a docs de Wave
  (siguen siendo útiles: la doc de Wave aplica al motor).

## Puntos de extensión identificados (para post-MVP)

- **Indicador de ambiente en tab bar**: `frontend/app/tab/tabbar.tsx` (~L668,
  junto a `<UpdateStatusBanner/>`); variante left-bar en `vtabbar.tsx`;
  por-bloque en `frontend/app/block/blockframe-header.tsx`.
- **Nuevo tipo de bloque**: `frontend/app/block/blockregistry.ts` + skill
  `.kilocode/skills/create-view/SKILL.md`.
- **Nuevos RPC**: `pkg/wshrpc/wshrpctypes.go` + `task generate` + skill
  `.kilocode/skills/add-rpc/SKILL.md`.
- **Widgets declarativos**: `widgets.json` (sin código; abre bloques con
  blockdef.meta preconfigurada) — candidato ideal para runbooks.
- **Config propia**: skill `.kilocode/skills/add-config/SKILL.md`.

## Estado del baseline (previo al fork)

- `go vet ./...`: limpio.
- `go test ./...`: 1 fallo pre-existente (`TestGenerateWaveEventTypes`,
  assert desactualizado vs generador multilínea) — corregido en el fork.
- `npx tsc --noEmit`: 12 errores pre-existentes en `frontend/preview/`
  (mocks desactualizados) — corregidos en el fork.
- `npx vitest run`: 46/46 OK.
