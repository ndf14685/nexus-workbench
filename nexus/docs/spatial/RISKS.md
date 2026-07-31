# Spatial Workspace — Riesgos técnicos

- Fecha: 2026-07-30
- Relacionados: ADR-0006, TEST_PLAN.md

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|--------|-------|---------|------------|
| R1 | `cleanuporphaned` (Go+TS) destruye un bloque detached (queda en `blockids` pero fuera del árbol) | Alta sin guard | Crítico: pérdida del módulo y su sesión | Guard doble (CONTRACTS §6) + test obligatorio Go y TS; orden de operaciones en Detach: registrar detached ANTES de encolar `delete` de layout |
| R2 | Carrera en el drenado de `PendingBackendActions` (lectura-modificación-escritura con debounce 100 ms, sin CAS): acciones encoladas entre read y write-back pueden perderse | Media | Medio: módulo no aparece/desaparece hasta reload | En el MVP las acciones espaciales se serializan en el engine (una op de usuario a la vez por workspace, mutex); backlog: ack explícito o CAS por versión |
| R3 | `balanceNode` reasigna node ids → `DockMemory.IndexArr` obsoleto al volver | Alta (es comportamiento normal) | Bajo | Restauración best-effort con clamp + fallback a `insert` (documentado en DATA_MODEL §5); nunca fallar el Attach por posición |
| R4 | `display.id` inestable entre reinicios (Windows especialmente) | Media | Medio: módulos restaurados en monitor equivocado | `monitorId` compuesto label+resolución+scale (DATA_MODEL §6); fallback por bounds; test de matching |
| R5 | Bounds fuera de pantalla tras cambio de monitores/resolución/orientación; bounds negativos legítimos en Windows | Alta en multi-monitor real | Medio: ventana inaccesible | Validación al restaurar contra displays reales (`ensureBoundsAreVisible` ya existe y acepta negativos válidos); reconciliación en `display-removed`; regla: los datos guardados nunca se “corrigen”, solo la materialización |
| R6 | Ventana detached no completa su init (renderer crashea, JWT/route inválido) y el módulo queda “en el limbo” (fuera del árbol, sin ventana) | Baja | Alto | Timeout de init (patrón `DevInitTimeoutMs`); si falla → auto-Attach al main window; comando de rescate `workspace.attachModule` idempotente; al arrancar, todo detached sin ventana viva se reconcilia |
| R7 | Route id duplicado si dos ventanas intentan `surface:<id>` (restauración doble, respawn) | Baja | Medio | El stableid evict del ws server ya reemplaza el link viejo (`ws.go:225`); emain garantiza 1 ventana por surfaceId en su registry |
| R8 | Estado espacial corrupto bloquea el arranque | Baja | Alto | `migrateSpatialState` con recuperación segura: backup + estado vacío + warning (DATA_MODEL §8); test de layout corrupto |
| R9 | Divergencia del estado mock de Jarvis entre ventanas (singleton por renderer, H12) | Cierta | Bajo hoy (mock), Alto cuando haya runtime real | Aceptado en MVP y documentado; el runtime OpenClaw será backend-side; el diseño no bloquea esa migración (bus/atoms quedan) |
| R10 | Costo de upstream-sync por las inserciones en árbol Wave | Cierta | Medio recurrente | Inserciones mínimas con marcador `// nexus:`; inventario en MIGRATION_PLAN §D; ADR-0003 ya define el proceso |
| R11 | Funciones tab-céntricas dentro de detached (multi-input, drag entre bloques, widgets) no aplican | Cierta | Bajo | Fuera de alcance explícito del MVP; el menú contextual en detached oculta acciones no aplicables |
| R12 | Fugas de recursos: ventanas detached cerradas por el SO (no por el engine) dejan surfaces fantasma | Media | Bajo/Medio | Evento `closed` de la ventana → `SpatialAttachCommand` automático (política MVP: cerrar ventana = Pop In, no perder el módulo); reconciliación al arranque |
| R13 | Perfiles aplicados sobre otro hardware (monitores distintos) | Cierta | Bajo | Matching declarativo + reconciliación de monitores ausentes (misma vía que R5); el perfil conserva el mapping original |
| R14 | Rendimiento: N ventanas = N renderers (memoria) | Media | Medio en hardware chico | MVP: sin límite duro pero telemetría de conteo; backlog: límite configurable + descarga de surfaces minimizadas |

Riesgo de producto (no técnico): scope creep hacia XR. Contención: los campos
XR existen solo como reserva de modelo; cualquier código XR está fuera de
alcance y el ADR lo fija.
