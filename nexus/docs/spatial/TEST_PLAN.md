# Spatial Workspace — Plan de pruebas

- Fecha: 2026-07-30
- Relacionados: ADR-0006, RISKS.md
- Runners: Go `go test ./...` (root), TS `vitest` (config existente),
  gate completo `nexus/scripts/verify.sh`. E2E manual guiado (multi-monitor
  real no es automatizable en CI headless; se scriptea lo scripteable con
  QEMU/xvfb en backlog).

## 1. Unit Go (`pkg/spatial`)

| Test | Cubre |
|---|---|
| Detach registra ModuleInstance con PrevDock y encola `delete` con actionid | núcleo detach |
| Attach restaura por IndexArr; con árbol cambiado cae a `insert` (R3) | posición previa "cuando sea posible" |
| Detach de módulo detached = move; Attach de módulo acoplado = no-op | idempotencia |
| Focus guarda snapshot una sola vez; Restore lo consume; doble Focus no pisa | focus/restore |
| `cleanuporphaned` Go excluye detached (mesa: bloque en blockids, fuera del árbol, marcado detached → NO se borra; sin marca → SÍ) | R1 crítico |
| `migrateSpatialState`: v desconocida y JSON corrupto → backup + estado vacío, sin error fatal | R8, recuperación ante layout corrupto |
| Reconciliación de monitor ausente: módulos → primario, `MonitorMemory` preserva mapping; reaparición restaura | R4/R5 |
| monitorId compuesto: matching por label/res/scale, desempate por bounds, colisión de gemelos | R4 |
| Perfil: save excluye lista negra (cmd:env, tokens) — test de lista blanca explícito | seguridad |
| Perfil: load idempotente por nombre, matching declarativo view+connection | perfiles |
| Serialización espacial: una op a la vez por workspace (mutex) | R2 |

## 2. Unit TS (vitest, `frontend/app/nexus/spatial/`)

| Test | Cubre |
|---|---|
| spatial-bus: entrega tipada, unsubscribe, handler que lanza no corta la cadena (patrón jarvis-bus) | bus |
| spatial-bus alimentado por evento WPS simulado → re-emite tipo correcto | puente WPS |
| atoms espaciales: detached set derivado de SpatialState | estado |
| guard TS de cleanupOrphanedBlocks con detached presentes | R1 crítico |
| spatial-menu: visibilidad condicional de ítems (detached vs docked vs snapshot presente) | menú |
| spatial-api: cada comando invoca la RPC correcta y emite `jarvis.commandReceived` | API Jarvis |
| BlockNodeModel sintético de SurfaceApp cumple la interfaz (focus/magnify/close no lanzan) | detached render |

## 3. Integración Go (patrón `wshserver_workspacecreate_test.go`, wstore real en temp dir)

| Test | Cubre |
|---|---|
| Detach→Attach ida y vuelta: blockids intacto, controller no destruido (registry), layout con las dos acciones encoladas | no perder estado, no duplicar |
| Un solo bloque por moduleId tras N ciclos detach/attach (sin duplicación de objetos) | no duplicar módulos |
| DeleteBlock de un detached limpia ModuleInstance + surface + snapshot | GC |
| Restart simulado: SpatialState releído, detached sin ventana viva → reconciliado | persistencia/restauración |
| 000012 up/down sobre DB poblada | migración de schema |

## 4. E2E guiado (desktop real; checklist del MVP obligatorio)

Script manual versionado en `nexus/docs/spatial/E2E_CHECKLIST.md` (se genera
con el MVP). Los 10 pasos del pedido, textual:

1. Abrir Terminal + Jarvis + CPU+Mem en la ventana principal.
2. Pop Out de Jarvis → misma sesión (tareas mock en curso siguen).
3. Mover Jarvis al segundo monitor (menú y comando `workspace.moveModule`).
4. Pop Out de CPU+Mem (la serie del gráfico continúa: datos vía WPS
   sysinfo, prueba de que no hay proceso duplicado).
5. Terminal permanece en la principal; escribir en el shell antes y después.
6. Focus sobre Jarvis (desde menú y desde `workspace.focusModule`).
7. Return → posición/tamaño anteriores exactos.
8. Cerrar Workbench, reabrir → distribución completa restaurada
   (incluye ventana en el monitor 2).
9. Verificar contenido: el shell del paso 5 conserva el historial escrito.
10. Desconectar monitor 2 → ventana migra al primario sin quedar
    inaccesible; reconectar → opción de restaurar mapping.

Variantes obligatorias: escalado distinto entre monitores (100%/150%),
bounds negativos (monitor a la izquierda del primario, Windows),
cerrar la ventana detached con la X del SO (= Pop In, módulo no se pierde),
matar la ventana detached (crash) → módulo rescatado al reiniciar (R6).

## 5. Regresión

`verify.sh` completo en cada fase + suite existente (jarvis.test.ts,
envsidebar, workspacecreate). Criterio de done por fase = gates del
MIGRATION_PLAN.
