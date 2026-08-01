# Nexus Workbench — Arquitectura

> Basado en inspección real del código en baseline `wave-baseline/v0.14.5-32-gc99022c1`.
> Detalle exhaustivo con rutas/símbolos: [INVENTORY_WAVETERM.md](INVENTORY_WAVETERM.md).

## Capas

```
┌────────────────────────────────────────────────────────────┐
│ 4. NexusOS (futuro, opcional)                              │
│    identidad · policy · riesgo · auditoría   [ADR-0004]    │
├────────────────────────────────────────────────────────────┤
│ 3. Workbench Core (nexus/)                                 │
│    catálogo de ambientes · workspaces · comandos/runbooks  │
│    config YAML versionable · scripts · CI propio           │
├────────────────────────────────────────────────────────────┤
│ 2. Workbench Bridge  [ADR-0002, BRIDGE.md]                 │
│    contrato estrecho sobre wshrpc + config nativa de Wave  │
│    HOY: importador de config (import-environments.mjs)     │
├────────────────────────────────────────────────────────────┤
│ 1. WaveTerm Engine (árbol upstream, diff mínimo)           │
│    Electron/React · xterm.js · Monaco · SSH · wsh · SQLite │
└────────────────────────────────────────────────────────────┘
```

## El motor (WaveTerm) — arquitectura real encontrada

- **Proceso Electron** (`emain/`): `emain.ts` (`appMain`) lanza `wavesrv`
  (`emain-wavesrv.ts`), crea ventanas (`emain-window.ts`,
  `WaveBrowserWindow`), resuelve dirs de config/data (`emain-platform.ts`).
- **Backend Go `wavesrv`** (`cmd/server/main-server.go`): servidor web +
  websocket en `127.0.0.1` (puertos efímeros anunciados por stderr con el
  handshake `WAVESRV-ESTART`), y domain socket `wave.sock`.
- **RPC `wshrpc`** (`pkg/wshrpc/wshrpctypes.go` → `wshserver.go`): interfaz
  única `WshRpcInterface`; codegen con `task generate` produce el cliente TS
  (`frontend/app/store/wshclientapi.ts`) y Go (`pkg/wshrpc/wshclient/`).
- **CLI `wsh`** (`cmd/wsh/`): ~40 subcomandos; se instala en remotos en
  `~/.waveterm/bin/wsh` y corre `wsh connserver` como agente remoto.
- **SSH** (`pkg/remote/conncontroller/`): conexiones persistentes con
  keepalive (`connmonitor.go`), merge de `~/.ssh/config` + `connections.json`.
  WSL en paralelo: `pkg/wsl/`, `pkg/wslconn/`.
- **Terminales** (`pkg/blockcontroller/`, `pkg/shellexec/`): pty local
  (`creack/pty`), detección de shell (`pkg/util/shellutil` — en Windows
  prefiere `pwsh`, luego `powershell.exe`), WSL vía `wsl.exe -d <distro>`.
- **Persistencia**: dos SQLite en `<dataDir>/db/` — `waveterm.db`
  (`pkg/wstore`: workspaces, tabs, blocks, layouts como objetos `waveobj`) y
  `filestore.db` (`pkg/filestore`: scrollback/blobs). Migraciones embebidas en
  `db/migrations-*`.
- **Config**: JSON planos con claves `namespace:key` en
  `~/.config/waveterm/` — `settings.json`, `connections.json`,
  `presets.json`, `widgets.json`, etc. Defaults embebidos en
  `pkg/wconfig/defaultconfig/`. Watcher fsnotify con push al frontend.
- **Frontend** (`frontend/`): React + Jotai (`globalStore`), registry de
  vistas (`frontend/app/block/blockregistry.ts`: term, preview, web, waveai,
  sysinfo…), layout en árbol (`frontend/layout/`), xterm en
  `frontend/app/view/term/`, Monaco en `frontend/app/view/codeeditor/`.

## Decisiones estructurales del fork

1. **Diff mínimo dentro del árbol de Wave.** Cambios hoy: strings visibles de
   branding, feed propio del updater (`publish.owner/repo/channel`), defaults
   `autoupdate:enabled=true` (D-026, feed propio) y
   `telemetry:enabled=false`, guardas `repository_owner` en 4 workflows de
   upstream, y 3 fixes de compilación/tests ya rotos en el baseline.
2. **Todo lo propio vive en `nexus/`** (docs, config, scripts) más 3 workflows
   `nexus-*.yml`. Un merge de upstream casi nunca conflictúa con esto.
3. **La configuración propia es YAML versionable** fuera de la SQLite de Wave;
   se *proyecta* a la config nativa (connections/presets) vía importador. La
   SQLite sigue siendo del motor (layouts/estado de UI), no del producto.
4. **Distinción de ambientes sin código UI nuevo**: `term:theme` por conexión
   y presets de fondo `bg@nexus-<clase>` por tab. Un widget/indicador propio
   queda para post-MVP (los puntos de inserción exactos están inventariados).
5. **Identificadores internos intactos**: appId `dev.commandline.waveterm`,
   dirs `waveterm*`, env vars `WAVETERM_*`, binarios `wavesrv`/`wsh`,
   `~/.waveterm` remoto. Renombrarlos rompe wsh remoto instalado, migraciones
   y el handshake `WAVESRV-ESTART` — no aporta valor de producto hoy.

## Riesgos del fork (resumen)

| Riesgo | Mitigación |
|---|---|
| Release de Wave pisa el fork por autoupdate | `publish.url` → host `.invalid`; default off; canal propio nexo-v* |
| Conflictos en merges upstream | diff mínimo + zonas calientes documentadas en UPSTREAM_SYNC.md |
| Telemetría/pings a waveterm.dev | default `telemetry:enabled=false`; `WAVETERM_NOPING` documentado |
| Workflows upstream requieren secretos ajenos | guardas `repository_owner == 'wavetermdev'` |
| Migraciones de DB/config en releases nuevas | paso explícito del checklist de sync |
| Wave cambia internals que usa el Bridge | el contrato del Bridge es estrecho y está documentado; el importador solo toca archivos JSON de config pública |
