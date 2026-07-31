# ADR-0005 — Jarvis Block: copiloto operativo como bloque nativo

- Estado: aceptado (2026-07-31)
- Relacionados: ADR-0001 (motor reemplazable), ADR-0002 (Workbench Core boundary),
  ADR-0004 (gobernanza NexusOS), D-021 (Wave AI sin protagonismo), AI_PROVIDERS.md

## Contexto

Queremos una presencia permanente de Jarvis dentro del Workbench — un copiloto
operativo, NO un chat ni otro panel de IA. Filosofía: *"yo trabajo en la
terminal, Jarvis trabaja conmigo"*. Debe ejecutar trabajos largos mientras el
operador sigue trabajando, pedir aprobación para acciones sensibles, y estar
desacoplado de todo proveedor de IA (el runtime real será OpenClaw/Jarvis).

## Decisión

### Ubicación: view type nativo `"jarvis"`

Un **view type de bloque** (`BlockRegistry.set("jarvis", ...)`) es la ubicación
correcta: los bloques de Wave ya dan layout, resize, persistencia, magnify y
convivencia con terminales. Un panel fijo repetiría el error de Wave AI (D-021);
un widget flotante quedaría fuera del sistema de layout.

- Implementación completa en `frontend/app/nexus/jarvis/` (árbol propio).
- Diff en el árbol de Wave: **2 líneas** en `blockregistry.ts`.
- Se abre desde el widget `nexus-jarvis` (importador) o `wsh` con `view=jarvis`.

### Capas (no se mezclan)

| Capa | Archivo | Depende de |
|---|---|---|
| Dominio/contratos | `jarvis-types.ts` | nada |
| Eventos | `jarvis-bus.ts` (bus tipado `jarvis.*`) | types |
| Estado | `jarvis-store.ts` (task store + reducers puros) | bus, types |
| Runtime | `jarvis-runtime-mock.ts` (`JarvisRuntime`, `VoiceProvider`) | store, bus, types |
| Contexto | `jarvis-context.ts` (`WorkbenchContextProvider`) | **único** módulo que importa internals de Wave |
| Wiring | `jarvis-core.ts` (singleton: una sola presencia Jarvis) | todo lo anterior |
| UI | `jarvis.tsx`, `jarvis-ring.tsx`, `jarvis.css` | core (atoms), nunca el runtime directo |

Eventos: `jarvis.startListening/stopListening/taskCreated/taskUpdated/
taskCompleted/taskCancelled/contextChanged/resultReady/error`.

Tareas: `id, state (queued|running|waiting-approval|completed|cancelled|error),
title, progress, result, error, startedAt, endedAt` — reducers puros testeados;
las transiciones desde estados terminales están bloqueadas.

### Reemplazo por OpenClaw (futuro)

`JarvisCore` instancia `MockJarvisRuntime` y `MockVoiceProvider` en dos líneas.
El adaptador OpenClaw implementará `JarvisRuntime` contra el gateway
(`http://<host>:18789`, auth token) y/o el MCP del Workbench para contexto de
terminales. UI, store, bus y context provider no cambian. Las aprobaciones se
conectarán a la gobernanza ADR-0004 (hoy: solo UI, no ejecuta nada).

### Contexto del Workbench

`WorkbenchContext` (host, terminal, cwd, repo, branch, proyecto, workspace,
ambiente, archivo/texto seleccionado) se alimenta hoy con lo que el frontend ya
sabe (workspace, bloque enfocado → conexión → ambiente del catálogo, cwd del
term, archivo del preview). repo/branch/proyecto/selectedText quedan declarados
en la interfaz y sin fuente todavía (candidatos: OSC del shell, git en cwd vía
wshrpc). El prompt nunca es la única entrada.

### UI

Aro circular animado propio (SVG + CSS, sin assets copiados, transform/opacity
solamente, respeta `prefers-reduced-motion`) con 8 estados: idle, listening,
thinking, working, waiting-approval, speaking, success, error. Tres tamaños por
dimensiones reales del bloque: compact (solo aro), medium (aro + estado +
tareas activas + Hablar), large (+ orden escrita, tareas con progreso,
aprobaciones Approve/Edit/Reject con riesgo, resultados Ver/Descartar,
historial). Push-to-talk explícito; sin escucha permanente; wake word futuro.

## Consecuencias

- (+) Jarvis vive en el layout como cualquier bloque; N instancias muestran la
  misma presencia (core singleton).
- (+) Runtime/voz intercambiables sin tocar UI; sin acople a ningún proveedor.
- (+) Mock end-to-end permite validar UX de tareas/aprobaciones desde hoy.
- (−) El mock genera escenarios ficticios — debe quedar claro en la UI que es
  un preview hasta conectar OpenClaw.
- (−) `sizeModeFor` usa umbrales px fijos; revisar con DPI/zoom reales.
