# Spatial Workspace — Contratos e interfaces

- Fecha: 2026-07-30
- Relacionados: ADR-0006, DATA_MODEL.md

## 1. RPCs wshrpc (`pkg/wshrpc/wshrpctypes.go`, prefijo Spatial)

Autoridad única de mutación espacial. Tras editar, correr `task generate`.

```go
// Interfaz (WshRpcInterface):
SpatialGetStateCommand(ctx, CommandSpatialGetStateData) (*spatial.SpatialState, error)
SpatialDetachCommand(ctx, CommandSpatialDetachData) (string, error) // → surfaceId
SpatialAttachCommand(ctx, CommandSpatialAttachData) error
SpatialFocusCommand(ctx, CommandSpatialFocusData) error
SpatialRestoreCommand(ctx, CommandSpatialRestoreData) error
SpatialMoveCommand(ctx, CommandSpatialMoveData) error
SpatialSetMinimizedCommand(ctx, CommandSpatialSetMinimizedData) error
SpatialCloseModuleCommand(ctx, CommandSpatialCloseModuleData) error // extensión: cierre real de un detached
SpatialListMonitorsCommand(ctx) ([]spatial.MonitorInfo, error)
SpatialUpdateMonitorsCommand(ctx, monitors []spatial.MonitorInfo) error // extensión: emain empuja el catálogo
SpatialSaveProfileCommand(ctx, CommandSpatialProfileData) error
SpatialLoadProfileCommand(ctx, CommandSpatialProfileData) error
SpatialListProfilesCommand(ctx) ([]string, error)

// Tipos de datos:
type CommandSpatialGetStateData struct {
    WorkspaceId string `json:"workspaceid"`
}
type CommandSpatialDetachData struct {
    ModuleId  string                    `json:"moduleid"`            // blockId
    MonitorId string                    `json:"monitorid,omitempty"` // destino opcional
    Placement *spatial.SpatialPlacement `json:"placement,omitempty"` // bounds opcionales
    Fill      bool                      `json:"fill,omitempty"`      // MonitorSurface (ocupar workArea)
}
type CommandSpatialAttachData struct {
    ModuleId string `json:"moduleid"`
}
type CommandSpatialFocusData struct {
    ModuleId string `json:"moduleid"`
}
type CommandSpatialRestoreData struct {
    ModuleId string `json:"moduleid"`
}
type CommandSpatialMoveData struct {
    ModuleId  string                    `json:"moduleid"`
    MonitorId string                    `json:"monitorid,omitempty"`
    Placement *spatial.SpatialPlacement `json:"placement,omitempty"`
    // MonitorId sin Placement = mover conservando offset relativo (patrón moveWindowToDisplay)
}
type CommandSpatialSetMinimizedData struct {
    ModuleId  string `json:"moduleid"`
    Minimized bool   `json:"minimized"`
}
type CommandSpatialCloseModuleData struct {
    ModuleId string `json:"moduleid"`
}
type CommandSpatialProfileData struct {
    Name        string `json:"name"`
    WorkspaceId string `json:"workspaceid"`
}
```

Semántica clave:

- `Detach` sobre módulo ya detached = mover (idempotente-amistoso).
- `Attach` sobre módulo acoplado = no-op con warning.
- `Focus` guarda `FocusSnapshot` solo si no hay uno vigente para el módulo
  (doble focus no pisa el snapshot original); `Restore` consume el snapshot.
- Todas publican `spatial:update` tras persistir. Ninguna espera a que el
  renderer confirme (el motor ya funciona así con `PendingBackendActions`).

Extensiones fijadas durante la implementación (Tasks 4-11):

- **Structs en waveobj:** los tipos persistidos (SpatialState, Surface,
  MonitorInfo, etc.) viven en `pkg/waveobj/wtypespatial.go` y `pkg/spatial`
  los alias-ea; `wshrpctypes.go` los referencia como `waveobj.*` porque
  importar `pkg/spatial` ciclaría vía spatial→wcore→wshrpc. `MonitorInfo`
  también se genera a TS desde waveobj.
- **Semántica del payload de Move:** `module.moved` publica SOLO el
  placement pedido (`nil` en un move de monitor puro). Así emain distingue
  "aplicar bounds" de "mover al monitor conservando offset relativo", y el
  eco de un self-report de bounds queda idéntico a lo ya aplicado.
- **Catálogo de monitores:** Electron es el dueño. `emain-displays.ts`
  empuja el catálogo vigente con `SpatialUpdateMonitorsCommand` al arrancar
  y en cada `display-added/removed/metrics-changed`; el engine lo cachea en
  memoria, sirve `SpatialListMonitorsCommand` desde el cache y deriva
  `monitor.connected/disconnected` del diff entre catálogos (el engine
  queda libre de Electron).
- **Política de cierre:** cerrar la ventana detached con la X del SO NO
  cierra el módulo: emain lo traduce a `SpatialAttachCommand` (= Pop In,
  R12). El cierre real de un detached es `SpatialCloseModuleCommand` (solo
  detached; error si acoplado): limpia ModuleInstance + Surface + snapshot,
  publica `surface.closed` (emain cierra la ventana marcándola
  engineClosing para no re-disparar el Pop In) y recién entonces
  `DeleteBlock(recursive=false)` — nunca cascadea al tab.

## 2. Evento WPS y bus tipado frontend

WPS (árbol Wave, 1 evento nuevo):

```go
// pkg/wps/wpstypes.go
const Event_SpatialUpdate = "spatial:update" // type:"spatial.SpatialEventData"

// pkg/spatial/types.go
type SpatialEventData struct {
    Type        string          `json:"type"` // ver tabla
    WorkspaceId string          `json:"workspaceid"`
    ModuleId    string          `json:"moduleid,omitempty"`
    SurfaceId   string          `json:"surfaceid,omitempty"`
    MonitorId   string          `json:"monitorid,omitempty"`
    Payload     json.RawMessage `json:"payload,omitempty"`
}
```

Scope de publicación: `workspace:<workspaceId>`. Tipos (`SpatialEventData.Type`):

| Tipo | Emisor | Payload |
|---|---|---|
| `module.created` / `module.closed` | engine | — |
| `module.detached` / `module.attached` | engine | `Surface` |
| `module.moved` / `module.resized` | engine (vía sync de emain) | `SpatialPlacement` |
| `module.focused` / `module.focusReleased` | engine | `FocusSnapshot` |
| `module.minimized` | engine | `{minimized}` — extensión Task 10: SetMinimized necesita tipo propio (`module.moved` implicaría bounds) |
| `module.surfaceChanged` | engine | `{from,to}` |
| `surface.created` / `surface.closed` | engine | `Surface` |
| `monitor.connected` / `monitor.disconnected` | emain→engine | `MonitorInfo` |
| `workspace.layoutSaved` / `workspace.layoutRestored` | engine | `{profile}` |
| `context.changed` | jarvis-context (ya existe en jarvis-bus; se puentea) | `WorkbenchContext` |
| `jarvis.commandReceived` | spatial-api | `{command,args}` |

Frontend (`frontend/app/nexus/spatial/spatial-bus.ts`, patrón jarvis-bus):

```ts
export interface SpatialEventMap {
    "module.created": { moduleId: string };
    "module.closed": { moduleId: string };
    "module.detached": { moduleId: string; surface: Surface };
    "module.attached": { moduleId: string };
    "module.moved": { moduleId: string; placement: SpatialPlacement };
    "module.resized": { moduleId: string; placement: SpatialPlacement };
    "module.focused": { moduleId: string };
    "module.focusReleased": { moduleId: string };
    "module.minimized": { moduleId: string; minimized: boolean };
    "module.surfaceChanged": { moduleId: string; from: string; to: string };
    "surface.created": { surface: Surface };
    "surface.closed": { surfaceId: string };
    "monitor.connected": { monitor: MonitorInfo };
    "monitor.disconnected": { monitorId: string };
    "workspace.layoutSaved": { profile: string };
    "workspace.layoutRestored": { profile: string };
    "context.changed": { context: WorkbenchContext };
    "jarvis.commandReceived": { command: string; args: unknown };
}
export class SpatialBus { on/off/emit tipados; alimentado por la suscripción
WPS a "spatial:update" (waveEventSubscribeSingle), NUNCA por polling }
```

## 3. Fachada de comandos para Jarvis (`spatial-api.ts`)

```ts
// frontend/app/nexus/spatial/spatial-api.ts — reutilizable por UI, Jarvis y tests
export const workspace = {
    focusModule(moduleId: string): Promise<void>,
    restoreModule(moduleId: string): Promise<void>,
    detachModule(moduleId: string, opts?: {monitorId?: string; placement?: SpatialPlacement; fill?: boolean}): Promise<string>,
    attachModule(moduleId: string): Promise<void>,
    moveModule(moduleId: string, target: {monitorId?: string; placement?: SpatialPlacement}): Promise<void>,
    minimizeModule(moduleId: string, minimized: boolean): Promise<void>,
    closeModule(moduleId: string): Promise<void>,          // delega en el cierre estándar de bloques
    listMonitors(): Promise<MonitorInfo[]>,
    saveLayout(profileName: string): Promise<void>,
    loadLayout(profileName: string): Promise<void>,
    listLayouts(): Promise<string[]>,
};
```

Implementación: wrappers finos sobre `RpcApi.Spatial*Command`. Cada llamada
emite `jarvis.commandReceived` en el bus para trazabilidad. El MCP Go usa las
mismas RPCs vía `wsh` (sin código nuevo en el engine).

## 4. Interfaz de renderer

```ts
// frontend/app/nexus/spatial/renderer-types.ts (contrato; sin deps de Electron)
export interface WorkspaceRenderer {
    readonly rendererType: "desktop" | "web" | "xr" | "ar";
    createSurface(spec: SurfaceSpec): Promise<Surface>;
    destroySurface(surfaceId: string): Promise<void>;
    mountModule(moduleId: string, surfaceId: string): Promise<void>;
    unmountModule(moduleId: string, surfaceId: string): Promise<void>;
    moveModule(moduleId: string, placement: SpatialPlacement): Promise<void>;
    resizeModule(moduleId: string, placement: SpatialPlacement): Promise<void>;
    focusModule(moduleId: string): Promise<void>;
    restoreModule(moduleId: string): Promise<void>;
}
```

`DesktopRenderer` es la implementación distribuida real: el "cuerpo" vive en
emain (`emain-spatial.ts`) que reacciona a `spatial:update` y a órdenes RPC
(route `electron`); para `MainWindowSurface`, mount/unmount se materializan
vía `PendingBackendActions` sobre el árbol del tab (el LayoutModel existente
queda encapsulado detrás de esta interfaz, sin reescribirlo). `WebRenderer`,
`XRRenderer`, `ARRenderer`: no se implementan; el contrato es el punto de
enchufe.

## 5. Electron: IPC/preload y ventana desacoplada

Preload (`emain/preload.ts` + `frontend/types/custom.d.ts`, marcadores
`// nexus:`):

```ts
getDisplays(): Promise<MonitorInfo[]>;
onSpatialInit(cb: (opts: SpatialInitOpts) => void): void;
setSurfaceBounds(bounds: {x,y,width,height}): void; // detached window self-report
```

```ts
type SpatialInitOpts = { surfaceId: string; moduleId: string; tabId: string;
                         workspaceId: string; clientId: string; windowId: string };
type MonitorInfo = { monitorId: string; displayId: number; label: string;
                     bounds: Rect; workArea: Rect; scaleFactor: number;
                     primary: boolean; internal: boolean };
```

Ventana desacoplada (`emain/emain-spatial.ts`, patrón `emain-builder.ts`):
`BrowserWindow` plana, mismo `index.html` y preload, identidad por
`spatial-init`; bootstrap frontend `initSurface()` en `wave.ts` (rama nueva
junto a `initWave`/`initBuilder`): route wshrpc `surface:<surfaceId>`,
carga client/window/tab/workspace del módulo, monta `<SurfaceApp>` con un
`BlockNodeModel` sintético. `resize/move` de la ventana → debounce 400 ms →
`SpatialMoveCommand` (mismo patrón que `mainResizeHandler`).

Monitores (`emain/emain-displays.ts`): catálogo `MonitorInfo` desde
`screen.getAllDisplays()`, listeners `display-added/removed/metrics-changed`
→ RPC al engine (`monitor.connected/disconnected`) → reconciliación.

## 6. Guard de detached en cleanuporphaned

Contrato interno (2 inserciones `// nexus:` en árbol Wave):

- Go `pkg/service/blockservice.CleanupOrphanedBlocks`: excluir blockIds
  presentes en `SpatialState.Modules` con `IsDetached`.
- TS `layoutModel.cleanupOrphanedBlocks` (`layoutModel.ts:411`): ídem,
  leyendo el atom espacial del workspace.

Sin este guard, todo Pop Out termina en `DeleteBlock` — es el invariante
más crítico del diseño (test obligatorio).

## 7. Menú contextual de módulo

Ítems agregados al menú del block frame (helper fork-owned
`frontend/app/nexus/spatial/spatial-menu.ts`, hook mínimo en el menú
existente del header):

Pop Out · Pop In · Move to Monitor ▸ (submenu dinámico `listMonitors()`) ·
Move to Main Window · Focus · Return to Previous Position ·
Maximize Module · Minimize Module · Close Module ·
Save Layout as Profile… ("Guardar layout como perfil…", modal
`SpatialSaveProfileModal`) · Load Profile ▸ ("Cargar perfil ▸", submenu
dinámico `listProfiles()`; lista vacía → "(sin perfiles)" deshabilitado)

Visibilidad condicional: Pop In / Move to Main Window solo si detached;
Pop Out solo si acoplado; Return solo si hay `FocusSnapshot` o `PrevDock`.
Close delega en el flujo estándar (`uxCloseBlock`). Maximize acoplado =
magnify; detached = maximize de ventana. La sección de perfiles (guardar/
cargar) es siempre visible, acoplado o detached, tras un separador.

## 8. Perfiles — lista blanca de persistencia

Por módulo SOLO: `view`, `title`, `connection`, `file`, `url` (si la vista es
web/preview), `surfacetype`, `dock.indexarr`, `placement`, `monitorid`,
flags de visibilidad. Explícitamente excluidos: `cmd:env`, `cmd:*` scripts,
tokens, JWT, paths de credenciales, contenido de bloques, scrollback.
