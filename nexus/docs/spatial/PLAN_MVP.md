# Spatial Workspace MVP — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> o superpowers:executing-plans. Steps con checkboxes. Antes de cada tarea,
> leer: `nexus/docs/spatial/{ARCHITECTURE,DATA_MODEL,CONTRACTS}.md` y
> ADR-0006. Los tipos/firmas exactos están en esos docs y NO se repiten acá.

**Goal:** MVP de Spatial Workspace: detach/attach de módulos a ventanas
propias, multi-monitor, focus/restore, persistencia versionada y API
`workspace.*` para Jarvis, con Terminal/Jarvis/CPU+Mem como demo.

**Architecture:** engine backend-first (`pkg/spatial`) sobre wstore + WPS +
cola PendingBackendActions; ventanas detached patrón Builder; frontend
fork-owned en `frontend/app/nexus/spatial/`.

**Tech stack:** Go 1.x (root module), TS/React/jotai, Electron (emain),
vitest, golang-migrate.

## Global Constraints

- Reglas del repo (CLAUDE.md/rules.md): string constants (no enums Go),
  imports `@/`, exports nombrados, JSON lowercase sin underscores, comments
  mínimos, jamás `go build` manual (vet/compile vía verify), copyright 2026.
- Inserciones en árbol Wave: mínimas y marcadas `// nexus:`.
- Tras tocar `wshrpctypes.go` o tipos Go generables: `task generate`
  (NUNCA editar `gotypes.d.ts`/`wshclientapi.ts` a mano).
- Gate por tarea: `bash nexus/scripts/verify.sh` (go vet+test, tsc, vitest,
  build). Commit por tarea, mensaje estilo repo (`spatial: …`), en español.
- No guardar secretos en estado espacial ni perfiles (lista blanca
  CONTRACTS §8).

---

### Task 1: `pkg/spatial` — tipos, otype, migración, recuperación

**Files:**
- Create: `pkg/spatial/types.go` (tipos DATA_MODEL §1-§6 + const de
  surface types/renderer types/lifecycle states + tipos de evento
  CONTRACTS §2 + `MonitorInfo`)
- Create: `pkg/spatial/store.go` (`GetOrCreateSpatialState(ctx, workspaceId)`
  vía `DBGetAllObjsByType`+filtro workspaceid, `SaveSpatialState`,
  `DeleteForWorkspace`)
- Create: `pkg/spatial/migrate.go` (`MigrateSpatialState(st) (*SpatialState, bool)`
  — v desconocida/corrupta → backup en Meta + estado vacío)
- Create: `db/migrations-wstore/000012_spatial.up.sql` + `.down.sql`
  (mismo esquema uniforme `oid/version/data` que 000001)
- Modify: `pkg/waveobj/wtype.go` (`OType_Spatial = "spatial"` +
  `AllWaveObjTypes()` + struct registrable — el struct puede vivir en
  waveobj con alias en spatial si el ciclo de imports lo exige; preferir
  struct en `pkg/waveobj/wtypespatial.go` nuevo y helpers en `pkg/spatial`)
- Test: `pkg/spatial/spatial_test.go`

**Interfaces produce:** todo DATA_MODEL §1-§6 con json tags exactos.

- [ ] Test primero: crear estado, guardar, releer (wstore temp dir, patrón
      `wshserver_workspacecreate_test.go`: env vars + `wstore.InitWStore`).
- [ ] Test: `MigrateSpatialState` con schemaversion desconocida y con data
      corrupta → estado vacío + backup, sin error.
- [ ] Implementar mínimo; correr `go test ./pkg/spatial/...`.
- [ ] Migración 000012 con test de up/down implícito (InitWStore la aplica).
- [ ] `task generate` (tipos TS). Commit.

### Task 2: evento WPS `spatial:update`

**Files:**
- Modify: `pkg/wps/wpstypes.go` (const + `AllEvents`),
  `pkg/tsgen/tsgenevent.go` (`WaveEventDataTypes`)
- (data type `SpatialEventData` ya está en pkg/spatial o waveobj según T1)

- [ ] Las 3 ediciones canónicas (comentario `wpstypes.go:10-16`). `task
      generate`. verify. Commit.

### Task 3: frontend base — `spatial-bus.ts` + atoms

**Files:**
- Create: `frontend/app/nexus/spatial/spatial-bus.ts` (patrón exacto
  `jarvis-bus.ts`; `SpatialEventMap` CONTRACTS §2)
- Create: `frontend/app/nexus/spatial/spatial-model.ts` (singleton patrón
  Jotai Model del repo: `SpatialModel.getInstance()`, atoms:
  `spatialStateAtom` (releído on `spatial:update`), derivado
  `detachedModuleIdsAtom: Set<string>`; suscripción WPS
  `waveEventSubscribeSingle("spatial:update", scope workspace)` que
  re-emite en el bus tipado)
- Test: `frontend/app/nexus/spatial/spatial.test.ts`

**Interfaces produce:** `SpatialModel.getInstance()`,
`getSpatialBus(): SpatialBus`, `detachedModuleIdsAtom`.

- [ ] Tests del bus (entrega/unsub/handler que lanza) + puente evento WPS
      simulado → tipo re-emitido. `npx vitest run frontend/app/nexus/spatial`.
- [ ] Commit.

### Task 4: engine — Detach/Attach/GetState (RPC)

**Files:**
- Create: `pkg/spatial/engine.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (3 RPCs + data types CONTRACTS §1)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handlers delgados → engine)
- Test: `pkg/spatial/engine_test.go` (integración wstore temp)

**Semántica Detach (orden crítico, R1/R2):** con mutex por workspace:
1. cargar tab del bloque (`DBFindTabForBlockId`); capturar `DockMemory`
   (IndexArr actual se obtiene del árbol solo si está disponible en
   LayoutState.RootNode — parsear el árbol JSON best-effort; si no, omitir)
2. escribir `ModuleInstance{IsDetached:true, LifecycleState:"detached",
   CurrentSurfaceId:<nuevo>, PreviousSurfaceId:mainSurface, PrevDock}` +
   `Surface{Type:detachedwindow}` y PERSISTIR SpatialState
3. recién entonces `QueueLayoutActionForTab(delete blockid)`
4. publicar `spatial:update {module.detached}` con ContextWithUpdates.
**Attach:** inverso: encolar `insertatindex` con clamp (fallback `insert`),
borrar ModuleInstance/Surface, persistir, publicar `module.attached`.
La ventana la cierra emain al recibir el evento (T6) — el engine no conoce
Electron.

- [ ] Tests primero (ida/vuelta, idempotencia, blockids intacto, N ciclos
      sin duplicar — TEST_PLAN §3). Implementar. `task generate`. Commit.

### Task 5: guards `cleanuporphaned` (R1) — ANTES de exponer UI

**Files:**
- Modify: `pkg/service/blockservice/blockservice.go` (`// nexus:` excluir
  detached leyendo SpatialState del workspace del tab)
- Modify: `frontend/layout/lib/layoutModel.ts:411` (`// nexus:` excluir
  `detachedModuleIdsAtom` de SpatialModel)
- Test: Go en `pkg/spatial/engine_test.go` (mesa TEST_PLAN §1); TS en
  `spatial.test.ts` (guard con set no vacío)

- [ ] Tests primero (bloque detached NO se borra; no-detached SÍ). Commit.

### Task 6: emain — ventana detached + spatial-init

**Files:**
- Create: `emain/emain-spatial.ts` (patrón `emain-builder.ts`: registry
  `Map<surfaceId, BrowserWindow>`, `createDetachedWindow(surface, module)`,
  bounds desde `Surface.Bounds`/monitor con `ensureBoundsAreVisible`,
  IPC `spatial-init` con `SpatialInitOpts` CONTRACTS §5; `closed` no
  iniciado por engine → `SpatialAttachCommand` (política: cerrar = Pop In);
  `resize/move` debounced 400ms → `SpatialMoveCommand`)
- Modify: `emain/preload.ts` + `frontend/types/custom.d.ts`
  (`onSpatialInit`, `getDisplays` stub por ahora) `// nexus:`
- Modify: `emain/emain.ts` (init módulo + al arrancar: reconciliar
  SpatialState → recrear ventanas detached; suscripción WPS
  `spatial:update` vía el wshrpc de electron para reaccionar a
  detach/attach) `// nexus:`
- Modify: `emain/emain-wsh.ts` si hace falta handler electron-route

**Nota:** emain ya tiene cliente wshrpc (`initElectronWshrpc`) — usarlo
para RpcApi y para suscribirse a eventos (patrón de suscripción existente
en emain si lo hay; si no, poll cero: suscripción WPS por route electron).

- [ ] Implementar; probar manualmente con `task dev` si el entorno lo
      permite (headless: al menos tsc + build verdes). Commit.

### Task 7: frontend — `initSurface()` + `SurfaceApp`

**Files:**
- Create: `frontend/app/nexus/spatial/surfaceapp.tsx` (`SurfaceApp`:
  monta `<Block>` con `BlockNodeModel` sintético — isFocused atom true,
  isMagnified false, onClose → `workspace.attachModule`, focusNode no-op,
  toggleMagnify → maximize de ventana vía IPC; provee `TabModelContext`
  del tab dueño)
- Modify: `frontend/wave.ts` (rama `initSurface(opts)` junto a
  initWave/initBuilder: route `surface:<surfaceId>`, cargar client/window/
  tab/workspace waveobjs, NO layout model) `// nexus:`

**Cuidado:** revisar qué asume `Block`/`BlockFrame` del entorno
(FocusManager, tabModel, waveEnv). Si `BlockFrame` exige demasiado, montar
la vista con un frame reducido propio (`SurfaceBlockFrame`) reutilizando
`makeViewModel` + `viewModel.viewComponent` directamente — decisión del
implementador, documentarla en el commit.

- [ ] Implementar; test TS del BlockNodeModel sintético. Commit.

### Task 8: menú contextual espacial

**Files:**
- Create: `frontend/app/nexus/spatial/spatial-menu.ts` (ítems CONTRACTS §7,
  visibilidad condicional; usa skill `.kilocode/skills/context-menu`)
- Modify: hook mínimo en el menú del block header
  (`frontend/app/block/blockframe-header.tsx` o donde viva el context menu
  del frame) `// nexus:`
- Test: `spatial-menu` visibilidad en `spatial.test.ts`

- [ ] Pop Out / Pop In / Close funcionando end-to-end en dev. Commit.
- **GATE Fase 1:** detach de term/jarvis/sysinfo sin perder estado;
  cerrar ventana = Pop In; reinicio restaura. Anotar resultado en commit.

### Task 9: multi-monitor

**Files:**
- Create: `emain/emain-displays.ts` (catálogo `MonitorInfo` con monitorId
  compuesto DATA_MODEL §6; listeners display-added/removed/metrics-changed;
  reconciliación: módulos del monitor perdido → primario +
  `MonitorMemory`; reaparición → oferta de restauración vía evento)
- Modify: `pkg/wshrpc/wshrpctypes.go` (+`SpatialListMonitorsCommand`,
  `SpatialMoveCommand`, `SpatialSetMinimizedCommand`), handlers, engine
- Modify: `emain/preload.ts` (`getDisplays` real)
- Modify: `frontend/app/nexus/spatial/spatial-menu.ts` (submenu Move to
  Monitor dinámico; Move to Main Window)
- Test: Go matching de monitorId + reconciliación (TEST_PLAN §1)

- [ ] Tests + implementación + `task generate`. Commit.
- **GATE:** pasos 3 y 10 del checklist E2E.

### Task 10: Focus / Restore / Minimize / Maximize

**Files:**
- Modify: `pkg/spatial/engine.go` (+Focus/Restore con `FocusSnapshot`
  una-sola-vez, +SetMinimized), wshrpctypes, wshserver
- Modify: `frontend/app/nexus/spatial/spatial-model.ts` (docked focus =
  `layoutModel.magnifyNodeToggle` del nodo del bloque — obtener vía
  `getNodeByBlockId`; encapsulado en un método `focusDockedModule`)
- Modify: `emain/emain-spatial.ts` (focus/restore/minimize/maximize de
  ventana detached al recibir eventos)
- Test: Go snapshot semantics; TS focus docked llama magnify correcto

- [ ] Tests + implementación. Commit.
- **GATE:** pasos 6-7 del checklist (Focus Jarvis + Return una acción).

### Task 11: perfiles + `spatial-api.ts` completa

**Files:**
- Create: `pkg/spatial/profiles.go` (save/load/list en
  `<configdir>/nexus-profiles/`, lista blanca CONTRACTS §8, matching
  declarativo, reutiliza `ApplyPortableLayout` para lo acoplado)
- Modify: wshrpctypes (+3 RPCs perfiles), wshserver
- Create: `frontend/app/nexus/spatial/spatial-api.ts` (fachada
  `workspace.*` CONTRACTS §3, emite `jarvis.commandReceived`)
- Test: Go lista blanca (ningún `cmd:env`/token serializado), idempotencia;
  TS spatial-api → RPC correcta

- [ ] Tests + implementación + `task generate`. Commit.
- **GATE Fase 4:** guardar/cargar "Incident Response".

### Task 12: cierre — E2E checklist + verify total

**Files:**
- Create: `nexus/docs/spatial/E2E_CHECKLIST.md` (los 10 pasos + variantes
  TEST_PLAN §4, con resultado esperado por paso)
- Modify: `nexus/docs/DECISIONS.md` si surgieron decisiones nuevas

- [ ] `bash nexus/scripts/verify.sh` completo verde. Commit final.

## Self-review del plan (hecho al escribirlo)

- Cobertura spec: 9 capas ✔ (mapeo ARCHITECTURE §3); acciones de usuario ✔
  (T8/T9/T10); modo focus ✔ (T10); multi-monitor ✔ (T9); estado
  compartido ✔ (diseño, sin tarea: es propiedad del motor); event bus ✔
  (T2/T3); Jarvis API ✔ (T11); perfiles ✔ (T11); persistencia+migraciones ✔
  (T1); pruebas ✔ (por tarea + T12); restricciones (sin iframes/polling/
  duplicación) ✔ por diseño.
- Los "MVP obligatorio" pasos 1-10 quedan cubiertos por gates de T8/T9/T10
  y el checklist T12.
- Deuda consciente: drag&drop entre ventanas y multi-módulo por surface en
  backlog (MVP.md), no en este plan.
