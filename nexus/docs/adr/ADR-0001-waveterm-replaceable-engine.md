# ADR-0001: WaveTerm como motor de escritorio reemplazable

- Estado: Aceptada
- Fecha: 2026-07-28
- Decisores: ndf (owner), Claude (arquitecto delegado)

## Contexto

Nexus Workbench necesita estar operativo cuanto antes para reemplazar
WinSSHterm. Construir desde cero un terminal multiplexado con SSH, layouts
persistentes y archivos remotos tomaría meses. WaveTerm (Apache-2.0) ya
resuelve: Electron+React, xterm.js, Monaco, SSH con reconexión, `wsh` RPC,
persistencia SQLite de workspaces/tabs/blocks/layouts.

El riesgo es quedar estratégicamente atado a Wave: su roadmap, su branding,
su canal de autoupdate y sus decisiones internas.

## Decisión

1. WaveTerm se adopta como **motor táctico**: se forkea, se rebrandea de forma
   superficial y se mantiene sincronizable con upstream.
2. Todo lo propio de Nexus Workbench vive **agrupado y separado** del árbol de
   Wave: directorio `nexus/` (docs, config, scripts, CI propio). El diff contra
   upstream dentro del árbol de Wave se mantiene mínimo.
3. Las funcionalidades propias consumen Wave a través de un contrato estrecho
   (**Workbench Bridge**, ver ADR-0002) y nunca directamente sus internals,
   para que un futuro cambio de motor (u otra versión mayor de Wave) sólo
   requiera reimplementar el bridge.
4. Los identificadores internos de Wave (appId, `~/.waveterm`, env vars
   `WAVETERM_*`, sockets, nombres de binarios `wavesrv`/`wsh`) **no se
   renombran** en esta etapa: son parte del motor, no del producto.

## Consecuencias

- (+) MVP utilizable en días, no meses.
- (+) Merges de upstream baratos: el 95% del diff propio está fuera de su árbol.
- (+) El "producto" (catálogo de ambientes, runbooks, perfiles) es portable.
- (−) Dependencia táctica real: bugs de Wave son nuestros bugs hasta el merge.
- (−) Algunas superficies (branding profundo, updater) requieren tocar el árbol
  de Wave; esos puntos quedan inventariados y cercados en `INVENTORY_WAVETERM.md`.
