# ADR-0006 — Spatial Workspace: el módulo como unidad, la ventana como superficie

- Estado: Aceptada (2026-07-30)
- Fecha: 2026-07-30
- Decisores: NDF (operador), Claude (análisis y diseño)
- Relacionados: ADR-0001 (engine reemplazable), ADR-0002 (boundary del Core),
  ADR-0004 (gobernanza), ADR-0005 (bloque Jarvis), D-018, D-020;
  nexus/docs/spatial/ (arquitectura, modelo de datos, contratos, plan)

## Contexto

Nexo Workbench está pensado hoy como aplicación de ventana única: 1 ventana ⇄
1 workspace, 1 renderer por tab, geometría solo dentro del árbol flex del tab.
La visión de producto exige un entorno espacial modular: módulos visibles a la
vez, distribuidos entre monitores, con focus temporal y retorno, operables por
Jarvis, y con un camino futuro a XR sin reescribir el core.

El análisis del motor (2026-07-30, ver ARCHITECTURE.md §2) mostró que el
estado funcional de los módulos ya vive fuera del componente visual (ptys en
`blockcontroller`, scrollback en filestore, view models desechables), que el
broker WPS ya es fan-out multi-ventana, y que existe un patrón probado de
ventana secundaria (Builder). Lo que falta es la capa espacial: superficies,
engine, multi-monitor, persistencia espacial y API de comandos.

## Decisión

1. **La unidad es el módulo.** `ModuleInstance` es una capa espacial sobre el
   `waveobj.Block` existente (no un reemplazo): el bloque sigue siendo dueño
   de identidad, meta y runtime; la instancia agrega superficie, geometría
   espacial, foco, monitor y ciclo de vida espacial.
2. **Surface como concepto de primer nivel.** Tipos iniciales:
   `MainWindowSurface` (encapsula el layout de tab existente detrás de la
   interfaz, sin reescribirlo), `DetachedWindowSurface` (BrowserWindow patrón
   Builder, bootstrap `spatial-init`, route wshrpc `surface:<id>`),
   `MonitorSurface` (detached con bounds del monitor). `Web/XR/AR/Remote`
   quedan reservados en el modelo.
3. **Spatial Layout Engine backend-first.** `pkg/spatial` (Go) es la única
   autoridad de mutación espacial: persiste en el nuevo otype `spatial`
   (migración 000012), publica `spatial:update` por WPS y usa la cola
   `PendingBackendActions` para tocar árboles de tabs. Los renderers son
   consumidores de eventos; prohibido el polling.
4. **Pop Out sin duplicación.** Desacoplar = quitar la hoja del árbol +
   registrar detached + montar el mismo `blockId` en la ventana nueva. El
   bloque permanece en `Tab.BlockIds`; `cleanuporphaned` (Go y TS) se
   modifica para excluir módulos detached. Pop In invierte el proceso
   restaurando `previousSurfaceId` y la posición previa guardada.
5. **Focus reutiliza magnify** para módulos acoplados (ya es temporal,
   persistido y restaurable) y usa foco de ventana + snapshot de bounds para
   desacoplados. Siempre con `FocusSnapshot` previo y acción única de Return.
6. **Multi-monitor gobernado desde emain**, con catálogo de monitores por
   RPC, listeners de display, reconciliación al desconectar (módulos al
   primario, mapping original recordado para restauración) y validación de
   bounds en DIP.
7. **API de comandos `Spatial*Command`** en wshrpc + fachada TS
   `workspace.*`, consumible por UI, Jarvis y el MCP. La voz no forma parte
   de esta decisión.
8. **Perfiles** como JSON versionado en el config dir (`nexus-profiles/`),
   sin secretos ni credenciales (solo IDs, tipos de vista, geometría,
   monitores).
9. **Frontera de renderers.** Interfaz `WorkspaceRenderer` implementada hoy
   solo por `DesktopRenderer` (emain). El engine no importa Electron ni
   React. XR/AR/Web/Remote son implementaciones futuras de la misma
   interfaz.
10. **Convención de código:** todo lo nuevo es fork-owned (`pkg/spatial`,
    `frontend/app/nexus/spatial/`, `emain/emain-spatial*.ts`); las
    inserciones en árbol Wave se marcan `// nexus:` (ADR-0003).

## Alternativas consideradas

- **Detached = workspace+ventana Wave completa por módulo.** Descartada:
  arrastra tab bar, widgets y semántica 1 ventana ⇄ 1 workspace (H2); crea
  objetos pesados para mostrar un solo bloque.
- **iframes / segunda app / BrowserView compartida.** Descartadas por las
  restricciones del pedido (duplicación de estado, hacks) y porque el motor
  ya resuelve compartir estado vía wavesrv único.
- **Geometría espacial dentro del árbol flex.** Descartada: el árbol es
  relativo a un contenedor; posición absoluta multi-monitor pertenece al
  engine. Duplicar la fuente de verdad fue explícitamente evitado:
  `SpatialPlacement` es autoritativo solo con `isDetached`.
- **Un evento WPS por cada tipo de evento espacial.** Descartada para
  minimizar diff (3 ediciones por evento en árbol Wave); se usa un evento
  sobre (`spatial:update`) + bus tipado local `spatial-bus.ts`.

## Consecuencias

- (+) El mismo módulo se mueve entre superficies y monitores sin perder
  estado, sesión ni contexto; nada se duplica (proceso, pty, socket, SSH).
- (+) El core queda preparado para XR: engine/persistencia/bus/API ignoran
  el renderer; agregar un renderer no toca el modelo.
- (+) Jarvis obtiene una API de manipulación del workspace estable y
  gobernable (misma vía que el MCP, sujeta a ADR-0004 a futuro).
- (+) Restauración robusta: layout, monitores y perfiles versionados con
  migraciones; recuperación segura ante monitor ausente.
- (−) Dos inserciones de guard en `cleanuporphaned` y varios hooks mínimos
  en árbol Wave que habrá que sostener en upstream-sync (mitigado con
  marcadores `// nexus:`).
- (−) El estado mock de Jarvis es por renderer: dos ventanas con Jarvis
  divergen hasta que el runtime real sea backend-side (limitación aceptada,
  en backlog).
- (−) La ventana desacoplada renderiza un contexto reducido (sin tab bar ni
  widgets); funciones que asumen tab (multi-input de terminal, drag entre
  bloques) no aplican dentro de una detached window en el MVP.
- (−) Superficie de pruebas nueva significativa (multi-ventana,
  multi-monitor, restauración) — cubierta en TEST_PLAN.md.
