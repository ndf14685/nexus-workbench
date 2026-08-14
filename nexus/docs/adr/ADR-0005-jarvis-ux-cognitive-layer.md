# ADR-0005: Capa cognitiva Jarvis UX sobre el Mission Supervisor

- Estado: Aceptada
- Fecha: 2026-08-14

## Contexto

El Mission Supervisor (jarvisd + jarvis-agent, v0.15.0-beta.20) funciona pero
su interfaz humana son comandos PowerShell con IDs de misión. El objetivo del
producto es externalizar preocupaciones: contexto del módulo activo +
instrucción natural → misión supervisada, con el Workbench liberando
superficie visual sin perder contexto. Ver `nexus/docs/JARVIS_UX.md` (spec y
decisiones D-J1..D-J12).

## Decisión

1. **No se crea un segundo Jarvis.** La capa nueva es UI + captura de
   contexto + resolución de intención; toda decisión de misión sigue en
   jarvisd (MissionService/engine/evaluator) y toda ejecución en el camino
   SSE → jarvis-agent → wsh existente.
2. **La intención se resuelve en el cerebro, no en el frontend.** Se extiende
   el pipeline de intents existente de jarvisd (determinista → conversación →
   LLM) con los intents de misión. El Workbench solo captura texto y
   `JarvisContext[]` y llama `POST /intent`. Fail-safe: ambigüedad pregunta,
   nunca ejecuta.
3. **El overlay es un modal del stack existente** (`modalsModel`), invocado
   por `Ctrl+Space` vía `CommandRegistry`. Nada de ventanas Electron nuevas
   ni `globalShortcut` de SO.
4. **Parking por reparenting a SubBlock holder + snapshot en filestore**,
   nuevo RPC transaccional `MoveBlockToParent`. Es el único mecanismo del
   motor que conserva Block/proceso/scrollback fuera del layout y sobrevive
   al GC `cleanuporphaned`.
5. **La gobernanza no se simplifica:** se interpone la policy/auditoría
   existente de `nexus/mcp` en `JarvisAgent.execute()`, cerrando la
   asimetría con ADR-0004 §2 (hoy ese camino no pasa por ningún gate).
6. **CLI PowerShell (`jarvis*`) queda como API administrativa** — sin
   cambios de contrato; la UX nueva no depende de PowerShell.

## Consecuencias

- El frontend gana dependencia de red directa al brain (ya existía en el
  panel Jarvis); la config se unifica en `nexus:brainurl` + secret store.
- jarvisd gana el concepto `Mission.name` y el vocabulario de misión en su
  tabla de intents; los clientes viejos no se rompen (campos aditivos).
- `terminal.input` destructivo en ambientes prod pasa a requerir approval
  out-of-band: una misión puede quedar `needs_input` más a menudo — es el
  comportamiento correcto según el modelo de confianza.
- El parking introduce el primer holder de SubBlocks fuera de VDom; queda
  documentado como patrón reutilizable.
