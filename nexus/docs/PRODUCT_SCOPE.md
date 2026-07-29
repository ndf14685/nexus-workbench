# Nexus Workbench — Product Scope

> Estado: v0.1 (bootstrap). Última actualización: 2026-07-28.

## Qué es

Nexus Workbench es el IDE operativo personal para Windows de ndf, construido como
fork de [Wave Terminal](https://github.com/wavetermdev/waveterm). Su objetivo
inmediato es **reemplazar WinSSHterm** como herramienta diaria de operación.

WaveTerm es el **primer motor de escritorio reemplazable** del producto, no su
núcleo conceptual (ver [ADR-0001](adr/ADR-0001-waveterm-replaceable-engine.md)).

## Alcance de HOY (bootstrap)

- Repo preparado: ramas, baseline de Wave identificado y taggeado.
- Documentación de arquitectura, inventario y estrategia upstream.
- Branding visible "Nexus Workbench" donde es seguro.
- Autoupdate oficial de Wave neutralizado (no puede pisar el fork).
- Formato versionable de catálogo de ambientes + presets iniciales.
- Build de desarrollo reproducible (Linux hoy; Windows documentado y scripteado).
- Todas las capacidades originales de Wave preservadas (terminal, SSH, layouts,
  archivos remotos, PowerShell/WSL).

## MVP (para uso diario, reemplazo de WinSSHterm)

1. Terminales múltiples con layout persistente por workspace. *(heredado de Wave)*
2. SSH con reconexión y `wsh` remoto. *(heredado de Wave)*
3. PowerShell y WSL como shells locales en Windows. *(heredado de Wave)*
4. Archivos remotos (preview/edición vía Monaco). *(heredado de Wave)*
5. Catálogo de ambientes versionable (`nexus/config/environments.example.yaml`)
   importable a la configuración de conexiones de Wave.
6. Distinción visual de ambientes (lab / prod / trabajo) usando los mecanismos
   nativos de Wave (`term:theme`, colores de conexión) generados desde el catálogo.
7. Instalador Windows generado por CI o build local Windows.

## Posterior al MVP (backlog, en orden de valor)

- Workbench Bridge implementado sobre wshrpc (hoy: contrato documentado).
- Runbooks y comandos favoritos con confirmación para acciones privilegiadas.
- Widget/bloque propio "Environment Panel" (usa el sistema de widgets de Wave).
- Sincronización automatizada de releases upstream (workflow programado).
- Integración con NexusOS (identidad, policy, auditoría) — ver ADR-0004.
- Docker/K8s/systemd helpers como comandos del catálogo, luego como bloques.

## Expresamente FUERA de alcance ahora

- Reescribir componentes que Wave ya resuelve (terminal, layout, SSH, files).
- Abstraer todo Wave detrás de una capa artificial antes de necesitarlo.
- Telemetría propia, licenciamiento, distribución comercial.
- Gestión de secretos propia (se delega en ssh-agent / mecanismos nativos).
- Bloques UI nuevos complejos (posponer hasta post-MVP).

## Deuda técnica aceptada

- El branding profundo (appId, rutas `~/.waveterm`, nombres de binarios,
  dominio de sockets) NO se cambia todavía: alto riesgo, bajo valor. Ver
  `INVENTORY_WAVETERM.md` § Branding.
- El catálogo de ambientes se importa manualmente (script), no hay sync
  bidireccional con la SQLite interna de Wave.
- CI de fork reutiliza los workflows de Wave con ajustes mínimos.

## Criterios de aceptación del bootstrap

- [ ] `npm install` + build frontend + backend Go + wsh compilan sin errores.
- [ ] Tests originales de Wave pasan (Go + vitest) en el baseline y tras cambios.
- [ ] App muestra "Nexus Workbench" en título/branding visible.
- [ ] Autoupdate oficial no puede descargar releases de Wave sobre el fork.
- [ ] `nexus/config/*.example.yaml` existen y están documentados.
- [ ] Sin secretos en el repo (verificado).
- [ ] Instrucciones exactas de build/run en `DEVELOPMENT.md` y `WINDOWS_BUILD.md`.
