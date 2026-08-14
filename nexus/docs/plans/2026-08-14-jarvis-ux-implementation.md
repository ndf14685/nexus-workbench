# Jarvis UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans
> (ejecución inline por el autor del plan, que retiene el contexto del
> discovery completo). Checkboxes para tracking.

**Goal:** Ctrl+Space global → contexto automático + lenguaje natural →
misiones del Mission Supervisor, con parking de módulos, status ambiental,
notificaciones solo-atención y release por el canal beta existente.

**Architecture:** ver `nexus/docs/JARVIS_UX.md` (D-J1..D-J12) y ADR-0005.

**Tech Stack:** React+Jotai+vitest (frontend), Go (motor + nexus/mcp),
Python+pytest (jarvisd, repo jarvis-openclaw-desktop en rig3060).

**Spec:** `nexus/docs/JARVIS_UX.md`

## Global Constraints

- No romper el CLI PowerShell existente (`jarvis*`) ni el protocolo
  clients/SSE (cambios aditivos).
- No inventar datos de contexto: campo ausente > campo adivinado.
- `scrubSecrets` antes de mandar cualquier output al brain.
- Governance NexusOS intacta (gates/audit; ADR-0004).
- Release: SemVer del esquema actual (`0.16.0-beta.N`), canal `beta`,
  workflow `nexus-windows-package.yml` por tag `v*`.
- Regresión: vitest + `go test ./...` (nexus/mcp) + pytest jarvisd (1529)
  en verde antes del tag.

---

## Fase A — Cimientos: shortcuts + overlay

### A1. Fix matching de descriptores (bug mayúsculas)
- Modify: `frontend/app/nexus/commands/command-dispatcher.ts` —
  `getRegisteredShortcutKeys()` emite descriptores en convención Wave
  (letra minúscula, `Space` para " ").
- Test: `command-dispatcher.test.ts` — nuevo caso que ejercita
  `keyutil.checkKeyPressed(adaptFromElectronKeyEvent(ctrl+alt+j), desc)`
  === true (hoy false).

### A2. Dispatcher del fork en el keydown de xterm
- Modify: `frontend/app/view/term/term-model.ts` (~:773) — probar
  `dispatchWorkbenchCommandShortcut(waveEvent)` antes de
  `appHandleKeyDown`, sin `target` (evita el veto TEXTAREA).
- Test: unit del handler con registry poblado (mock).

### A3. Lista de teclas viva en main
- Modify: `frontend/app/store/keymodel.ts` — extraer
  `syncGlobalWebviewKeys()` exportada; `frontend/app/nexus/commands/shortcut-manager.ts`
  — invocarla en `setShortcut/resetShortcut/importConfig`.
- Test: shortcut-manager.test.ts spy sobre el sync.

### A4. Comando `jarvis.open` (Ctrl+Space) + GlobalOverlay esqueleto
- Create: `frontend/app/nexus/jarvis/jarvis-overlay.tsx` (`JarvisOverlay`,
  displayName "JarvisOverlay": input autofocus, Escape cierra, restaura
  foco al nodo previo vía `focusManager`).
- Modify: `frontend/app/modals/modalregistry.tsx` (registrar),
  `frontend/app/nexus/commands/workbench-commands.ts` (comando
  `jarvis.open`, `Ctrl+Space`, contexts `["global"]`, editable, toggle).
- Test: `jarvis-overlay.test.tsx` (render, escape, foco) +
  registro del comando en `workbench-commands.test.ts` si existe patrón.

### A5. Config unificada del brain
- Create: `frontend/app/nexus/jarvis/brain-config.ts` —
  `getBrainConfig(): {url, token}` lee setting `nexus:brainurl` y secret
  `nexus-brain-token` (RpcApi GetSecrets), fallback al meta del bloque
  jarvis legacy.
- Modify: `frontend/app/view/jarvis/jarvis.tsx` usa el helper.
- Test: brain-config.test.ts (precedencias).

## Fase B — JarvisContext

### B1. Captura terminal
- Create: `frontend/app/nexus/jarvis/context.ts` —
  `captureFocusedContext(): Promise<JarvisContextModule>` +
  `captureBlockContext(blockId)`: `GetFocusedBlockDataCommand` /
  `BlockInfoCommand` + RTInfo del payload + scrollback tail
  (`TermGetScrollbackLinesCommand`, cap 120 líneas, `scrubSecrets`).
- Test: context.test.ts con RpcApi mockeado (terminal, web, empty,
  bloque destruido → kind "empty" sin throw).

### B2. Título web persistido + captura web
- Modify: `frontend/app/view/webview/webview.tsx` — listener
  `page-title-updated` → `SetMetaCommand {"nexus:web:title": title}`
  (debounced, no toca `frame:title`).
- Test: unit del handler (mock webview element).

### B3. Inferencia de repo por workspaces
- Create: `frontend/app/nexus/jarvis/repo-infer.ts` —
  `inferRepo(cwd, environments): {repo?, environmentId?}` matching de
  prefijos contra `workspaces` del setting `nexus:environments` (puro).
- Test: repo-infer.test.ts (win/unix paths, ~, sin match → undefined).

### B4. Strip de contexto en el overlay
- Modify: `jarvis-overlay.tsx` — "Contexto: Terminal · rig3060 ·
  idp-platform" con el capture al abrir; estado "sin contexto" limpio.

## Fase C — Cerebro (jarvis-openclaw-desktop, rig3060)

### C1. `Mission.name`
- Modify: `app/missions/model.py` (+`name`), `store.py` (migración
  aditiva), `service.py`/`http_api.py` (snapshot + create), naming
  heurístico `app/missions/naming.py` (repo basename + verbo del
  objetivo, ≤4 palabras).
- Test: tests/missions/test_naming.py + regresión store/service.

### C2. Intents de misión
- Create: `app/intelligence/mission_intents.py` — tabla determinista es
  (query/stop/pause/resume/status/handoff verbs) + resolución por nombre
  con ambigüedad → lista numerada (needs_confirmation).
- Modify: `app/intelligence/intents.py` (hook de la tabla),
  `service.py` (handlers `_HANDLERS`), wiring a MissionService.
- Test: tests/intelligence/test_mission_intents.py (los 7 conceptos §5 +
  ambigüedad + no-match cae al pipeline previo).

### C3. Handoff con contexts
- Modify: `http_api.py` `/intent` acepta `contexts`; handler de handoff
  construye objective enriquecido + DoD sintetizado + decide modo
  (adopt si el contexto trae terminal con agente activo; materialized
  default; headless si el texto lo pide) y llama `missions.create`.
- Test: test_handoff_contexts.py (terminal→adopt, sin contexto→resolver,
  web+terminal multi).

### C4. Resultado humano
- Modify: engine/evaluator — al completar, persistir `result_summary`
  (de la última observation); snapshot lo expone.
- Test: test de transición completed con summary.

### C5. ADOPT en el engine
- Modify: `app/missions/engine.py` — spawn_worker con `existing_block_id`
  (sin terminal.create; set_meta jarvis:* sobre el bloque adoptado).
- Test: test_engine adopt path (fake workbench).

### C6. Deploy
- pytest completo (1529+) → commit → push → ff canónico + restart.

## Fase D — Workbench UX completa

### D1. Overlay ↔ brain
- Modify: `jarvis-overlay.tsx` + Create `frontend/app/nexus/jarvis/brain-client.ts`
  (`postIntent(handoff): Promise<IntentResponse>`, timeout, errores
  legibles); render de response/needs_confirmation (opciones numeradas).
- Test: brain-client.test.ts (fetch mock), overlay flow test.

### D2. Status ambiental + badges
- Create: `frontend/app/nexus/jarvis/status-model.ts` (singleton, poll
  3 s `/missions`, atoms por misión, `workingCount`, `attentionCount`).
- Modify: `frontend/app/tab/tabbar.tsx` (indicador junto a
  `NexusEnvIndicator`, click abre overlay en modo status),
  `frontend/app/block/blockframe-header.tsx` (badge `● Jarvis` si meta
  `jarvis:mission`, tooltip con nombre+estado).
- Test: status-model.test.ts (agregación, transiciones).

### D3. Notificaciones solo-atención
- Modify: status-model.ts — detector de transiciones →
  `RpcApi.NotifyCommand` con nombre + `result_summary` solo en
  completed/failed/blocked/needs_input; dedupe por misión+estado.
- Test: casos de spam (running→running silencioso; N pasos silenciosos).

### D4. Parking
- Create Go: `pkg/wshrpc` + `pkg/wcore` `MoveBlockToParentCommand`
  (transaccional: ParentORef + listas origen/destino) + holder block
  `nexus:parkinglot` por workspace; test Go.
- Create: `frontend/app/nexus/jarvis/parking.ts` (`parkBlock(blockId,
  note?)` — snapshot meta+scrollback a filestore zona `nexus:parked` +
  reparent + quitar del layout SIN DeleteBlock; `restorePark(id)`;
  `listParked()`).
- Modify: block context menu (`blockframe` menú "…") — "Delegar a
  Jarvis", "Preguntar a Jarvis", "Guardar para después"; overlay sección
  Parking Lot (listar/restaurar/cerrar).
- Test: parking.test.ts + go test; test de reinicio (snapshot presente
  sin holder → restore por recreación).

### D5. HEADLESS
- Modify: status-model/parking — worker block con meta `nexus:headless`
  (enviada por el brain en terminal.create) se parkea al detectarse;
  "Ver trabajo" en overlay/status lo materializa.
- Test: flujo simulado con meta.

### D6. Observabilidad
- Create: `frontend/app/nexus/jarvis/telemetry.ts` — `jarvisLog(event,
  data)` (console estructurada + buffer en memoria consultable), sin
  secretos. Instrumentar invoke/capture/resolve/handoff/park/restore.

## Fase E — Gobernanza, docs, E2E, release

### E1. Gates en jarvis-agent
- Modify: `nexus/mcp/jarvisagent.go` — `terminal.input`: check
  `DestructivePatterns` + clase del ambiente del bloque (catálogo) →
  prod/destructivo exige approval broker; todas las capabilities →
  `Auditor`. Reusar `App.gateWithContext`/`ApprovalBroker` existentes.
- Test: jarvisagent_test.go casos gate/deny/audit.

### E2. Docs
- Modify: `nexus/docs/MCP.md` (jarvis-agent + tools nuevas),
  `UPSTREAM_SYNC.md` (tabla de canales post-d4fd56c9),
  `WINDOWS_BUILD.md` (firma), `JARVIS_UX.md` estado final + deuda.

### E3. Regresión completa
- vitest + `go test ./...` (raíz y nexus/mcp) + pytest jarvisd.

### E4. E2E reales (§28)
1. Terminal en repo real → Ctrl+Space → "seguí con esto y avisame" →
   misión con contexto correcto → completion → notificación, sin IDs.
2. Ctrl+Space sin terminal → "investigá X y encargate" → resolver o
   pregunta mínima.
3. "Guardá esto para después" → cerrar módulo → reiniciar Workbench →
   restaurar.

### E5. Release
- Modify: `.github/workflows/nexus-windows-package.yml` (+`make/*.blockmap`).
- `task version -- minor true` (0.16.0-beta.0) → changelog en
  RELEASES-notas del release → commit `release: v0.16.0-beta.0` → tag →
  push GitHub → CI verde → verificar assets (`beta.yml`) → Check for
  Updates en la app instalada → actualizar → smoke post-update.
