# Nexus Workbench — Build e instalador Windows

## Estado

- El empaquetado Windows **no puede hacerse desde Linux** con el Taskfile
  actual: `build:server:windows` está gateado a `platforms: [windows]` y
  `wavesrv` requiere cgo (sqlite). Verificado en `Taskfile.yml`.
- Vías soportadas: **CI en GitHub** (recomendada) o **build local en Windows**.
- Firma: **cert autofirmado propio** ("Nestor Fleitas", generado con
  `nexus/scripts/new-signing-cert.ps1`, ver `SIGNING.md`). CI firma con los
  secrets `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` + variable
  `NEXUS_PUBLISHER_NAME`; sin esos secrets el build sale sin firmar y
  `verifyUpdateCodeSignature` queda apagado.

## Vía 1 — CI (recomendada)

Workflow: `.github/workflows/nexus-windows-package.yml`.

1. Push del tag `vX.Y.Z[-beta.N]` a GitHub (o Actions → *Run workflow*).
2. Al terminar (~15-25 min): artifact `nexus-workbench-windows` con
   `NexusWorkbench-win32-x64-<version>.exe` (NSIS), `.msi`, `.zip`,
   `beta.yml`/`latest.yml`, SBOM y `SHA256SUMS.txt`.
3. Tags `-beta.N` publican la **prerelease automáticamente** (canal beta del
   updater); tags estables quedan en **draft** hasta publicarlos a mano
   (ver `UPSTREAM_SYNC.md` § Canales).

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

"Check for Updates" (menú de la app) consulta **las GitHub Releases de
`ndf14685/nexus-workbench`** — nunca los servers de Wave. Solo ve releases
publicadas (los drafts que crea CI son el canal candidate). El chequeo
automático periódico sigue apagado por default (`autoupdate:enabled=false`);
el manual funciona siempre. Flujo completo en UPSTREAM_SYNC.md § Canales.

Nota: los builds anteriores a v0.14.6 se empaquetaron con un feed inválido a
propósito; para engancharse al canal de updates hay que instalar v0.14.6+.
La config y los workspaces se conservan al actualizar (viven en
`~/.config/waveterm` y la data dir, no en Program Files).

## Datos de la app en Windows

- Config: `~/.config/waveterm/` (`settings.json`, `connections.json`, …)
- Data (SQLite, shell integration): `%LOCALAPPDATA%\waveterm\` (envPaths)
- El instalador NO borra datos al reinstalar/actualizar.
