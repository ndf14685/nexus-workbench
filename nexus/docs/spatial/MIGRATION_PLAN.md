# Spatial Workspace — Plan de migración incremental

- Fecha: 2026-07-30
- Relacionados: ADR-0006, MVP.md

Principio: no reemplazar nada de golpe. El layout actual (árbol flex +
LayoutModel) sigue siendo el motor de la ventana principal; se lo encapsula
detrás de las interfaces espaciales. Cada fase deja el producto funcionando
y es shippeable por separado.

## Fase 0 — Fundaciones (sin cambio visible)

1. `pkg/spatial`: tipos (`SpatialState`, `ModuleInstance`, `Surface`,
   `SpatialPlacement`, snapshots), registro del otype `spatial`, migración
   SQL `000012_spatial`, `migrateSpatialState` con recuperación ante
   corrupción. Tests Go puros.
2. Evento WPS `spatial:update` (3 ediciones canónicas) + `task generate`.
3. Frontend: `spatial-bus.ts` (tipado, alimentado por WPS) + atoms de estado
   espacial del workspace. Tests vitest del bus (patrón jarvis.test.ts).

Gate: `verify.sh` verde; ninguna conducta de usuario cambia.

## Fase 1 — Detach/Attach (el corazón del MVP)

4. Engine Go: `SpatialDetachCommand`/`SpatialAttachCommand`/
   `SpatialGetStateCommand` con mutex por workspace; encolan acciones de
   layout (`delete`/`insertatindex`) y persisten `SpatialState`.
5. Guard de detached en `cleanuporphaned` Go y TS (R1) — con tests antes
   del primer detach real.
6. emain: `emain-spatial.ts` (ventana detached patrón Builder,
   `spatial-init`, registry surfaceId→window, `closed` → auto-attach) +
   handlers en route `electron`.
7. Frontend: rama `initSurface()` en `wave.ts`, `SurfaceApp` (monta
   `<Block>` con BlockNodeModel sintético), menú contextual Pop Out/Pop In.

Gate: detach de Terminal/Jarvis/CPU+Mem sin perder estado (shell sigue,
scrollback restaurado); cerrar la ventana = Pop In; reinicio restaura.

## Fase 2 — Multi-monitor

8. `emain-displays.ts`: catálogo `MonitorInfo`, listeners de display,
   `SpatialListMonitorsCommand`, `SpatialMoveCommand`, "Move to Monitor"
   en el menú, reconciliación de monitor ausente (`MonitorMemory`).

Gate: prueba obligatoria del MVP pasos 3 y 10 (mover a segundo monitor;
desconectarlo y recuperar de forma segura).

## Fase 3 — Focus / Restore / Minimize / Maximize

9. `SpatialFocusCommand`/`SpatialRestoreCommand` + `FocusSnapshot`;
   acoplado = magnify (encapsulado tras la API), detached = ventana al
   frente + bounds temporales. Minimize/Maximize por módulo.

Gate: prueba obligatoria pasos 6-7 (Focus Jarvis y Return con una acción).

## Fase 4 — Perfiles + API Jarvis completa

10. `nexus-profiles/` con lista blanca, save/load/list, matching
    declarativo; `spatial-api.ts` completo; eventos
    `workspace.layoutSaved/Restored`; integración MCP vía `wsh` (sin código
    nuevo en engine).

Gate: guardar "Incident Response", limpiar, cargar, verificar distribución.

## D — Inventario de inserciones en árbol Wave (a sostener en upstream-sync)

| Archivo | Inserción |
|---|---|
| `pkg/waveobj/wtype.go` | otype `spatial` en `AllWaveObjTypes` |
| `pkg/wps/wpstypes.go` + `pkg/tsgen/tsgenevent.go` | evento `spatial:update` |
| `pkg/wshrpc/wshrpctypes.go` (+ generados) | RPCs `Spatial*` |
| `pkg/service/blockservice/…` | guard detached (R1) |
| `frontend/layout/lib/layoutModel.ts` | guard detached (R1) |
| `emain/emain.ts` | init de `emain-spatial`/`emain-displays` + restauración |
| `emain/preload.ts` + `frontend/types/custom.d.ts` | IPC monitores + spatial-init |
| `frontend/wave.ts` | rama `initSurface()` |
| menú del block frame | hook ítems espaciales |
| `db/migrations-wstore/000012_*` | tabla nueva (aditiva, sin conflicto) |

Todo lo demás es fork-owned en `pkg/spatial`, `frontend/app/nexus/spatial/`,
`emain/emain-spatial*.ts` y no genera conflictos de merge.

## Estrategia de reversión

Cada fase es aditiva. Rollback = no invocar las RPCs (la UI esconde el menú).
La migración 000012 tiene `.down.sql`; el estado espacial es descartable sin
afectar bloques ni workspaces (los módulos detached huérfanos se
re-adjuntan por reconciliación de arranque).
