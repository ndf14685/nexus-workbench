# Nexus Workbench — Build e instalador Windows

## Estado

- El empaquetado Windows **no puede hacerse desde Linux** con el Taskfile
  actual: `build:server:windows` está gateado a `platforms: [windows]` y
  `wavesrv` requiere cgo (sqlite). Verificado en `Taskfile.yml`.
- Vías soportadas: **CI en GitHub** (recomendada) o **build local en Windows**.
- La firma de código requiere secretos DigiCert de Command Line Inc que no
  tenemos: los instaladores salen **sin firma** (SmartScreen va a advertir;
  "More info" → "Run anyway", una sola vez por instalador).

## Vía 1 — CI (recomendada)

Workflow: `.github/workflows/nexus-windows-package.yml`.

1. Push del repo a GitHub (rama o tag `nexus-vX.Y.Z`).
2. GitHub → Actions → **Nexus Windows Package** → *Run workflow* (o el push
   del tag lo dispara solo).
3. Al terminar (~15-25 min), bajar el artifact `nexus-workbench-windows`:
   contiene `NexusWorkbench-win-x64-<version>.exe` (NSIS), `.msi` y `.zip`.
4. Ese artefacto es el canal **candidate**; probarlo y recién entonces
   considerarlo **stable** (taggear el commit).

## Vía 2 — Build local en Windows

Requisitos (PowerShell, con [scoop](https://scoop.sh) o instaladores):

```powershell
scoop install nodejs-lts go zig task git
git clone <fork> ; cd waveterm
npm ci
task package    # con CSC_IDENTITY_AUTO_DISCOVERY=false si molesta la firma
```

Resultado en `make/`: `NexusWorkbench-win-x64-0.14.5.exe` + msi + zip.

Nota de BUILD.md upstream: electron-builder en Windows funciona mejor desde
PowerShell clásico que desde pwsh para el paso de firma; sin firma no importa.

## Solo desarrollo en Windows (sin instalador)

```powershell
task electron:winquickdev   # build wavesrv nativo + app dev con HMR
```

## Actualizaciones

El autoupdate quedó neutralizado (`publish.url` → host `.invalid`, default
`autoupdate:enabled=false`). Actualizar = instalar el nuevo `.exe` encima
(NSIS actualiza in-place; la config y los workspaces se conservan porque
viven en `%HOME%\.config\waveterm` y en la data dir, no en Program Files).

## Datos de la app en Windows

- Config: `~/.config/waveterm/` (`settings.json`, `connections.json`, …)
- Data (SQLite, shell integration): `%LOCALAPPDATA%\waveterm\` (envPaths)
- El instalador NO borra datos al reinstalar/actualizar.
