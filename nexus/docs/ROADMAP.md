# Nexus Workbench — Roadmap

## Fase 0 — Bootstrap (HOY, hecho)

Fork preparado, baseline taggeado, docs/ADRs, branding visible, autoupdate
neutralizado, catálogo de ambientes + importador, CI propio, validación local.

## Fase 1 — Reemplazo real de WinSSHterm (días)

1. Correr `nexus-windows-package.yml` en GitHub → instalar el .exe en Windows.
2. Crear `environments.yaml` real (NexusOS, raspi-media, rig3060, WSL, trabajo)
   e importarlo; validar temas por clase.
3. Uso diario: SSH, PowerShell, WSL, archivos remotos, workspaces por ambiente.
4. Ajustes de fricción encontrados en el uso (issues en el fork).

## Fase 2 — Workbench Core operativo (semanas)

- ~~Indicador de ambiente en tab bar~~ (hecho 2026-07-29: `NexusEnvIndicator`
  en `frontend/app/nexus/envindicator.tsx`, catálogo vía setting
  `nexus:environments` proyectado por el importador — D-016).
- ~~Widgets declarativos para comandos favoritos~~ (hecho 2026-07-29: el
  importador genera `nexus-cmd-*` desde `commands.yaml`; solo comandos sin
  placeholders y no destructivos — el resto espera Bridge.runCommand con
  confirmación).
- Importador de workspaces declarativos (`workspaces.yaml` → wshrpc).
- Bridge: implementar `openTerminal`/`openConnection`/`getActiveEnvironment`.
- Iconos/assets propios de Nexus Workbench.

## Fase 3 — DevOps/DevSecOps (semanas-meses)

- Runbooks con confirmación (destructive/prod) vía Bridge.runCommand.
- Helpers Docker/K8s/systemd como bloques o widgets.
- SBOM + govulncheck en CI; firma de instaladores (cert propio) si se justifica.
- Sync upstream a Wave v0.15+ usando el pipeline (primer ensayo real).

## Fase 4 — Integración NexusOS (posterior)

- Policy/audit hooks en el Bridge (ADR-0004).
- Identidad y ejecución gobernada.
- Evaluar si Wave sigue siendo el motor o se reemplaza (ADR-0001 lo permite).
