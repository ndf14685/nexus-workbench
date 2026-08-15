# Jarvis UX — Delegación cognitiva sobre el Mission Supervisor

Fecha: 2026-08-14 · Estado: diseño aprobado, en implementación
Spec de origen: pedido del operador "evolución integral de Nexus Workbench" (§1–§34).
Relacionado: ADR-0005 (este diseño), ADR-0004 (frontera NexusOS), `PANEL_IDENTITY.md`, `MCP.md`.

## Objetivo

El Workbench soporta 50 módulos; el operador quiere sostener 2–5 temas activos
sin perder contexto. La capa Jarvis UX convierte "módulos abiertos" en
"responsabilidades delegadas": contexto capturado automáticamente + intención
en lenguaje natural → misión del Mission Supervisor existente. No se crea un
segundo Jarvis: esta capa es UI/contexto/intención **encima** de jarvisd.

```
Usuario ── Ctrl+Space / menú contextual ── Jarvis Overlay (Workbench)
                                              │  JarvisContext[] + texto
                                              ▼
                                   jarvisd /intent + /missions  (cerebro)
                                              │  SSE capability.invoke
                                              ▼
                                jarvis-agent → wsh → bloques/terminales
                                              │
                                   NexusOS governance (gates/audit)
```

## Decisiones (resumen; detalle en ADR-0005)

- **D-J1 Overlay in-app, no ventana nueva.** `GlobalOverlay` como modal del
  stack existente (`modalsModel` + `modalregistry`), portal sobre los
  webviews (`--zindex-modal-wrapper: 500` > webview 100). `Ctrl+Space` como
  comando del `CommandRegistry` (`jarvis.open`, editable). Escape cierra vía
  `globalKeyMap`. Sin `globalShortcut` de SO (colisión con IMEs; el quake
  toggle ya ocupa esa capa).
- **D-J2 Arreglar la cañería de shortcuts, no rodearla.** Tres bugs
  preexistentes impedían que CUALQUIER atajo del fork funcione con foco en
  webview/terminal: (1) descriptores `Ctrl:Alt:J` con mayúscula implican
  Shift en `parseKeyDescription` → nunca matchean; (2) el handler de xterm
  llama `appHandleKeyDown` salteando `dispatchWorkbenchCommandShortcut`;
  (3) la lista `register-global-webview-keys` queda stale al reasignar.
  Se corrigen los tres — beneficia a todos los comandos, no solo a Jarvis.
- **D-J3 JarvisContext se captura con APIs existentes, sin inventar datos.**
  Terminal: `GetFocusedBlockDataCommand` + meta (`cmd:cwd`, `connection`) +
  RTInfo (`shell:state/lastcmd/lastcmdexitcode`) + scrollback tail
  (`TermGetScrollbackLinesCommand`, fallback filestore). Repo: inferido por
  matching de `cmd:cwd` contra `workspaces` del catálogo de environments
  (señal de ownership ya definida para el resolver de jarvisd); branch solo
  si hay fuente confiable — si no, se omite. Web: `meta.url` +
  `webview.getTitle()`; se agrega listener `page-title-updated` →
  `nexus:web:title` (meta libre). Multi-módulo: el payload es `contexts: []`
  desde el día uno.
- **D-J4 La resolución de intención vive en jarvisd.** Se extiende el
  pipeline existente (`intents.py` determinista → conversación de pendientes
  → router LLM aibudget) con los intents de misión: observe / continue /
  take_ownership / supervise / query / stop / pause / resume. El Workbench
  manda `POST /intent` con `{text, contexts}`; jarvisd responde
  `{handled, response, needs_confirmation, metadata}` (contrato ya
  existente). Fallback determinista y fail-safe: ambigüedad → pregunta, no
  acción.
- **D-J5 Misiones con nombre humano.** `Mission.name` corto generado en la
  creación (heurística repo+objetivo, refinable por LLM). Los `m-xxxx`
  quedan como identificador interno. Status, notificaciones y control por
  lenguaje natural usan el nombre.
- **D-J6 Tres modos de ejecución.** MATERIALIZED = flujo actual
  (terminal.create visible). HEADLESS = el mismo worker pero con su bloque
  **parkeado** (fuera del layout, proceso y scrollback vivos) — "Ver
  trabajo" lo materializa. ADOPT = la misión se ata a un bloque existente
  (`jarvis:mission` en meta, sin crear terminal) y el supervisor
  observa/delega sobre él.
- **D-J7 Parking = SubBlock holder + snapshot.** En caliente: reparent del
  Block a un holder invisible (mecanismo probado por VDom; inmune al GC
  `cleanuporphaned`), nuevo RPC transaccional `MoveBlockToParent`. Red de
  seguridad para reinicios: snapshot serializado (meta + scrollback) en zona
  filestore `nexus:parked`. Restore = reparent inverso +
  `QueueLayoutActionForTab(InsertNode)`. Bloques web: snapshot alcanza
  (url/título/nota). Marcas: `nexus:parked`, `nexus:parked:at`,
  `nexus:parked:from`, `nexus:parked:note`.
- **D-J8 Config del brain unificada.** Setting global `nexus:brainurl` +
  token en el secret store de Wave (`nexus-brain-token`), proyectados una
  vez; el panel Jarvis y el overlay leen de ahí (el meta por bloque queda
  como override legacy). El jarvis-agent sigue con env vars (documentado).
- **D-J9 Status ambiental + notificaciones solo-atención.** Un
  `JarvisStatusModel` singleton (polling 3 s a `/missions`, compartido con
  el panel) alimenta: indicador discreto en la tab bar ("Jarvis · N
  trabajando · M atención"), badges `● Jarvis` en headers de bloques con
  `jarvis:mission`, y notificaciones nativas (`RpcApi.NotifyCommand`) SOLO
  en transiciones terminales o needs_input/blocked — nunca por pasos.
  El texto de la notificación es el resultado (nombre + summary), no logs.
- **D-J10 Gobernanza: cerrar la asimetría del jarvis-agent.** Hoy
  `JarvisAgent.execute()` esquiva gates y auditoría (contra ADR-0004 §2).
  Se interpone la policy existente: patrón destructivo en `terminal.input`
  sobre ambientes `class=prod`/contexto productivo → requiere approval
  broker; toda capability se registra en el auditor JSONL. La UX no
  simplifica la gobernanza por detrás.
- **D-J11 Persistencia.** Misiones y contextos viven en jarvisd
  (MissionStore SQLite, ya persistente). Parking en filestore + waveobj
  (sobreviven reinicios de Workbench/Windows). El agente corre como tarea
  programada persistente. Al abrir Workbench, el status model reconstruye
  desde `GET /missions` + zona `nexus:parked`.
- **D-J12 Observabilidad.** Eventos `jarvis.invoke`, `jarvis.context.capture`,
  `jarvis.intent.resolve`, `jarvis.handoff`, `jarvis.mission.*`,
  `jarvis.park/restore` → log local del renderer (console + archivo vía
  `RecordTEventCommand` cuando aplique) sin contenido sensible (se reusa
  `scrubSecrets` de panelactivity).

## Modelo de datos

```ts
// frontend/app/nexus/jarvis/context.ts
type JarvisContextModule =
  | { kind: "terminal"; blockId: string; title?: string; connection: string;
      cwd?: string; repo?: string; branch?: string; shellState?: string;
      lastCommand?: string; lastExitCode?: number; recentOutput?: string;
      environmentId?: string; jarvisMission?: string }
  | { kind: "web"; blockId: string; url: string; title?: string; domain?: string }
  | { kind: "empty" };

interface JarvisHandoff {
  text: string;                       // instrucción natural del usuario
  contexts: JarvisContextModule[];    // 0..N módulos
  source: "overlay" | "block-menu";
  workspaceId?: string; tabId?: string;
}
```

jarvisd: `Mission.name: str` (nuevo), intents de misión en
`app/intelligence/mission_intents.py` (nuevo), `POST /intent` acepta
`contexts` (lista opacа que el handler de misión sabe interpretar).

## Seguridad

- El token del brain nunca viaja al DOM de webviews ni se loguea.
- `scrubSecrets` obligatorio antes de mandar scrollback/output al brain.
- "Encargate" NO es permiso ilimitado: risk tiers y approval gates de
  NexusOS intactos (D-J10); acciones destructivas siguen gateadas.
- Actor preservation: las terminales de misión llevan `jarvis:*` en meta;
  la auditoría registra principal=usuario, actor=jarvis-agent.

## Tests

- Workbench: vitest (dispatcher/shortcuts, context capture, overlay,
  parking model, status model, notificaciones), go test (`nexus/mcp`,
  `MoveBlockToParent`).
- jarvisd: pytest (mission intents, naming, adopt/headless, resolver de
  contexts, regresión de 1529 tests).
- E2E reales (§28): terminal+repo → Ctrl+Space → "seguí con esto" →
  misión con contexto capturado → completion sin conocer IDs; delegación
  sin terminal; park → reinicio → restore.

## Deuda explícita conocida (estado al cierre de la implementación)

- Entrada por voz: fuera de alcance de esta release (la arquitectura del
  overlay deja el hook: el input es un componente aislado).
- Branch de git en terminales remotas: solo si hay fuente confiable
  (shell integration no lo reporta hoy); se omite antes que inventarlo.
- Multi-select visual de módulos: v1 = módulo enfocado + selección desde
  el Parking/status; la API ya es `contexts: []`.
- ~~HEADLESS automático~~ CERRADA en Detached Runtime (ADR-0006): el spec
  de worker acepta `headless: true`, jarvisd lo propaga en `terminal.create`
  y el jarvis-agent parkea el bloque al nacer (`wsh block park`). "Ver
  trabajo"/Retomar lo materializa.
- Los intents de misión entran solo por `POST /intent` (overlay); el camino
  TCP del HUD/voz (`BrainBackedTransport`) no los rutea todavía.
- Cierre automático de módulos al completar misión (§17): solo notificación
  + badge; no se cierran módulos automáticamente (comportamiento
  conservador a propósito).

## Detached Runtime (v0.17, ADR-0006)

La UI dejó de ser dueña de la ejecución. Resumen operativo:

- `wavesrv --detached` corre supervisado por la Scheduled Task
  **NexusRuntime** (logon + restart on failure), instalada
  idempotentemente por la app al arrancar. Rendezvous por
  `<dataDir>/runtime.json` + `runtime.authkey` (0600).
- Cerrar o matar `NexusWorkbench.exe` NO detiene el runtime, las
  terminales, los workers ni las misiones. Primera vez muestra un aviso
  informativo (config `nexus:runtime:closenotice`).
- Ownership de sesión: meta `nexus:owner` (`ui|mission|user`). El
  jarvis-agent lo setea en `terminal.create` y el ADOPT lo transfiere en
  `terminal.set_meta`.
- Workers remotos de Jarvis son **jobs durables** (`term:durable=true` →
  `wsh jobmanager` con PPID 1 en el host remoto): sobreviven al cierre de
  la UI, a un restart del runtime y a cortes de red (`ReconnectJob`).
- Workers/terminales **locales** sobreviven al cierre de la UI pero NO a
  un restart del runtime (fail-safe: recovery de jarvisd → `needs_input`).
  Extender jobmanager a local+Windows queda como deuda.
- Semántica de cierre (§19 del spec): X = solo UI; "Shutdown Nexus
  Runtime…" (menú) = drain informado + stop total; `wsh runtime
  status|stop` por CLI; el updater detiene el runtime antes de instalar
  (o difiere si hay misiones activas).
- Al reabrir: attach + digest "mientras no estabas" (un solo toast) +
  badges de atención. El watchdog re-attachea solo si el runtime se
  reinicia (puertos efímeros nuevos → relaunch de ventanas).
- jarvisd: liveness del canal por `last_seen` (45s), race spawn→blocked
  cerrado con el status `spawning`, atención asíncrona por inbox dirigido,
  `/health` con resumen de misiones, protocolo v1.4 con
  `protocol_version`/`agent_version` en el register.
- Deuda nueva explícita: notificación nativa con la app cerrada (el inbox
  la retiene hasta reabrir; falta un puente toast desde el servicio),
  banner dedicado de "runtime reconectando" en el renderer (hoy: UX de WS
  desconectado existente + relaunch automático), y hardening del minteo
  de JWT del MCP (lee la clave de `waveterm.db`; mover a DPAPI/keyring).
