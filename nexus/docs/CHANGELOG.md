# Changelog — Nexus Workbench (fork)

Cambios propios del fork; lo heredado de Wave Terminal se documenta en los
releases de upstream.

## v0.16.0-beta.1 — 2026-08-14 · "Restore de parking"

### Arreglado
- **Retomar desde el Parking Lot ahora monta el bloque de verdad.** El
  restore devolvía el bloque a `tab.blockids` y limpiaba `nexus:parked`,
  pero el `waveobj:update` del LayoutState (con el insert pendiente) nunca
  se emitía: el bloque quedaba invisible y huérfano, expuesto al GC.
  `UnparkBlockCommand` ahora difunde los updates acumulados del contexto
  (block + tab + layoutstate), igual que la creación de bloques.
  (Detectado en los E2E reales de §28.)

## v0.16.0-beta.0 — 2026-08-14 · "Jarvis UX: delegación cognitiva"

La evolución integral de ADR-0005: delegar responsabilidad a Jarvis en
lenguaje natural, con contexto capturado automáticamente, y liberar
superficie visual sin perder estado.

### Nuevo
- **Ctrl+Space — Jarvis global**: overlay conversacional invocable desde
  cualquier módulo (también con foco dentro de ChatGPT/YouTube/terminal),
  Escape cierra, comando `jarvis.open` editable en el registry.
- **Contexto automático (`JarvisContext`)**: al invocar Jarvis desde una
  terminal viaja cwd, conexión, repo (inferido por los `workspaces` del
  catálogo), estado del shell, último comando/exit code y tail del
  scrollback (con `scrubSecrets`); desde un módulo web viaja url/título.
- **Lenguaje natural sobre misiones** (cerebro jarvisd): observe / continue /
  take_ownership / supervise / query / stop / pause / resume, con nombres
  humanos de misión (`Mission.name`), desambiguación conversacional y
  fail-safe (ambigüedad pregunta, jamás ejecuta).
- **ADOPT**: "seguí vos con esto" adopta la terminal actual (el engine
  reutiliza el bloque taggeado y hereda su conexión real) en vez de abrir
  una nueva.
- **Parking**: "guardá esto para después" o el menú `…` del bloque sacan el
  módulo de la superficie sin perder su estado (Block + scrollback +
  procesos Go quedan intactos; inmune al GC de huérfanos); Parking Lot en
  el overlay con Retomar/cerrar; sobrevive reinicios.
- **Status ambiental**: indicador discreto en la tab bar ("Jarvis · N
  trabajando · M atención"), badge `● Jarvis` en bloques con misión.
- **Notificaciones solo-atención**: nativas, únicamente en
  completed/failed/needs_input/blocked, con el resultado humano
  (`result_summary`) — nunca pasos internos.
- **Gobernanza en jarvis-agent** (cierra la asimetría con ADR-0004 §2):
  input destructivo sobre ambientes `prod` se deniega en el Workbench y
  toda capability de escritura se audita en `nexus-mcp-audit.jsonl`.
- Config unificada del brain: setting `nexus:brainurl` + token en el secret
  store (formulario de primera vez en el overlay).

### Arreglado
- Los atajos `Ctrl+Alt+*` del fork ahora funcionan con el foco dentro de un
  webview (bug de mayúsculas en los descriptores: `Ctrl:Alt:J` implicaba
  Shift para keyutil) y dentro de xterm (el keydown del terminal salteaba
  el dispatcher del fork).
- La lista de teclas interceptadas en main se refresca al reasignar atajos
  (antes quedaba stale hasta reiniciar).
- El release sube `*.blockmap`: el auto-update vuelve a ser diferencial.

### Deuda conocida (ver `nexus/docs/JARVIS_UX.md`)
- HEADLESS automático (auto-park del worker) — el park manual del worker ya
  funciona con la misión corriendo.
- Intents de misión solo por HTTP `/intent` (HUD/voz TCP pendiente).
- Cierre automático de módulos al completar misión: solo notificación
  (conservador a propósito).
