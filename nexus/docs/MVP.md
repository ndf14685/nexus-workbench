# Nexus Workbench — MVP

## Definición

La menor versión que reemplaza a WinSSHterm en el trabajo diario:
multi-terminal con layouts persistentes + SSH confiable + PowerShell/WSL +
archivos remotos + ambientes distinguibles y versionados.

## Estado por capacidad (2026-07-28)

| # | Capacidad | Origen | Estado |
|---|---|---|---|
| 1 | Terminales múltiples + layout persistente | motor Wave | FUNCIONA (heredado, validado por tests/build) |
| 2 | SSH con reconexión + wsh remoto | motor Wave | FUNCIONA (heredado; validar en Windows real) |
| 3 | PowerShell / WSL | motor Wave (`shellutil`, `pkg/wsl`) | PREPARADO (código presente; requiere Windows para probar) |
| 4 | Archivos remotos (preview/Monaco) | motor Wave | FUNCIONA (heredado) |
| 5 | Workspaces por ambiente | motor Wave (UI) | FUNCIONA (heredado); declarativo = backlog |
| 6 | Catálogo de ambientes versionable | nexus | FUNCIONA (`environments.yaml` + importador) |
| 7 | Distinción visual por clase | nexus→config nativa | FUNCIONA (term:theme + bg presets) |
| 8 | Branding Nexus Workbench | nexus | FUNCIONA (strings visibles) |
| 9 | Autoupdate de Wave neutralizado | nexus | FUNCIONA (feed .invalid + default off) |
| 10 | Instalador Windows | CI | PREPARADO (`nexus-windows-package.yml`; falta correrlo en GitHub) |

## Criterios de aceptación del MVP completo

- [ ] Instalador Windows generado por CI, instalado y usado un día completo.
- [ ] 3+ ambientes reales importados; temas correctos por clase.
- [ ] SSH a NexusOS / raspi / rig3060 con reconexión verificada.
- [ ] PowerShell 7 y WSL Ubuntu como terminales locales.
- [ ] Edición de un archivo remoto vía preview.
- [ ] Workspaces separados por ambiente que sobreviven reinicio.

## Fuera del MVP (recordatorio)

Runbooks ejecutables, widget de ambiente propio, workspaces declarativos
auto-creados, integración NexusOS, iconos propios.
