# Spatial Workspace — Modelo de datos

- Fecha: 2026-07-30
- Relacionados: ADR-0006, ARCHITECTURE.md, CONTRACTS.md

Convención: campos JSON en minúsculas sin guiones bajos (regla del repo).
Los nombres TypeScript se generan desde Go vía `task generate`.

## 1. Nuevo otype `spatial` (waveobj `SpatialState`)

Un objeto por workspace. Creado lazy la primera vez que ocurre una operación
espacial. Migración SQL `000012_spatial` crea `db_spatial` (mismo esquema
uniforme oid/version/data).

```go
// pkg/spatial/types.go (registrado en waveobj.AllWaveObjTypes)
type SpatialState struct {
    OID           string                     `json:"oid"`
    Version       int                        `json:"version"`
    SchemaVersion int                        `json:"schemaversion"` // ver §6
    WorkspaceId   string                     `json:"workspaceid"`
    Surfaces      map[string]*Surface        `json:"surfaces,omitempty"`
    Modules       map[string]*ModuleInstance `json:"modules,omitempty"` // key = moduleId = blockId
    FocusSnapshots map[string]*FocusSnapshot `json:"focussnapshots,omitempty"` // key = moduleId
    MonitorMemory map[string]*MonitorMap     `json:"monitormemory,omitempty"`  // key = monitorId ausente
    Meta          waveobj.MetaMapType        `json:"meta,omitempty"`
    CreatedTs     int64                      `json:"createdts"`
    UpdatedTs     int64                      `json:"updatedts"`
}
```

## 2. `ModuleInstance`

`moduleId == blockId` (decisión: no crear un segundo espacio de IDs; el bloque
ya es la identidad estable del módulo). La instancia existe en `Modules` solo
cuando el módulo tiene estado espacial no-default (detached, focused,
minimizado, o memoria de posición previa); un bloque acoplado "normal" no
necesita entrada.

```go
type ModuleInstance struct {
    Id                string            `json:"id"`   // == blockId
    Type              string            `json:"type"` // meta.view: term|jarvis|sysinfo|preview|web|...
    Title             string            `json:"title,omitempty"`
    LifecycleState    string            `json:"lifecyclestate"` // created|active|detached|minimized|closed
    CurrentSurfaceId  string            `json:"currentsurfaceid"`
    PreviousSurfaceId string            `json:"previoussurfaceid,omitempty"`
    Placement         *SpatialPlacement `json:"placement,omitempty"` // autoritativo SOLO si isdetached
    PrevDock          *DockMemory       `json:"prevdock,omitempty"`  // para Pop In / Return
    MonitorId         string            `json:"monitorid,omitempty"`
    IsDetached        bool              `json:"isdetached,omitempty"`
    IsFocused         bool              `json:"isfocused,omitempty"`
    IsMinimized       bool              `json:"isminimized,omitempty"`
    IsMaximized       bool              `json:"ismaximized,omitempty"`
    ContextBinding    map[string]string `json:"contextbinding,omitempty"` // ej: connection, env id
    CreatedTs         int64             `json:"createdts"`
    UpdatedTs         int64             `json:"updatedts"`
}
```

Notas de autoridad (evita doble fuente de verdad):

- `state` funcional del módulo: NO está acá. Vive donde siempre: `block.meta`,
  filestore, controller, rtinfo. `ModuleInstance` es solo estado espacial.
- Acoplado (`isdetached=false`): posición/tamaño = árbol flex del tab
  (`LayoutState.RootNode`). `Placement` se ignora; `PrevDock` guarda dónde
  re-insertarlo.
- Desacoplado (`isdetached=true`): `Placement` + `MonitorId` son la verdad;
  la ventana Electron los materializa.
- `Title` es cache de presentación (`meta["frame:title"]` o nombre derivado
  de la vista); se refresca al persistir, nunca se usa como identidad.
- `zIndex` del pedido: para detached lo materializa el sistema operativo
  (orden de ventanas); se persiste en `Placement.ZIndex` como orden de
  restauración (qué ventana se levanta última = al frente).

## 3. `SpatialPlacement` — preparado para XR sin usarlo aún

```go
type SpatialPlacement struct {
    X      int     `json:"x"`
    Y      int     `json:"y"`
    Width  int     `json:"width"`
    Height int     `json:"height"`
    ZIndex int     `json:"zindex,omitempty"`
    // Reservados para XR/AR (no usados por DesktopRenderer):
    Z            float64    `json:"z,omitempty"`
    Rotation     *Vec3      `json:"rotation,omitempty"`
    Depth        float64    `json:"depth,omitempty"`
    Anchor       string     `json:"anchor,omitempty"` // world|surface|hand|gaze (reservado)
    SpatialScale float64    `json:"spatialscale,omitempty"`
}

type Vec3 struct {
    X float64 `json:"x"`
    Y float64 `json:"y"`
    Z float64 `json:"z"`
}
```

Coordenadas desktop: DIP de Electron, coordenadas de pantalla virtuales
(pueden ser negativas en Windows con monitor a la izquierda/arriba — se
validan contra displays reales al restaurar, nunca se "corrigen" al guardar).

## 4. `Surface`

```go
type Surface struct {
    Id            string            `json:"id"`
    Type          string            `json:"type"` // const: mainwindow|detachedwindow|monitor (reservados: web|xr|ar|remote)
    RendererType  string            `json:"renderertype"` // const: desktop (reservados: web|xr|ar)
    Bounds        *SpatialPlacement `json:"bounds,omitempty"`        // ventana en coords de pantalla
    AvailableArea *SpatialPlacement `json:"availablearea,omitempty"` // workArea del monitor al persistir
    MonitorId     string            `json:"monitorid,omitempty"`
    ScaleFactor   float64           `json:"scalefactor,omitempty"`
    ModuleIds     []string          `json:"moduleids,omitempty"`
    // Solo mainwindow:
    WindowId      string            `json:"windowid,omitempty"` // waveobj.Window
    TabId         string            `json:"tabid,omitempty"`
    Meta          waveobj.MetaMapType `json:"meta,omitempty"`
    CreatedTs     int64             `json:"createdts"`
    UpdatedTs     int64             `json:"updatedts"`
}
```

- `MainWindowSurface`: una por ventana Wave; `ModuleIds` no duplica el árbol
  (se deriva de `tab.blockids` − detached); existe para que el engine tenga
  un destino direccionable ("Move to Main Window").
- `DetachedWindowSurface`: 1 módulo por surface en el MVP (`ModuleIds` de
  largo 1). El modelo admite N para el futuro (mini-layout en detached).
- `MonitorSurface`: `DetachedWindowSurface` con `bounds = workArea` del
  monitor y flag en `Meta["monitorfill"]=true`. No es un tipo runtime
  distinto en el MVP.

## 5. `DockMemory`, `FocusSnapshot`, `MonitorMap`

```go
// Dónde estaba el módulo dentro del árbol del tab antes de detach/focus.
type DockMemory struct {
    TabId     string `json:"tabid"`
    IndexArr  []int  `json:"indexarr,omitempty"`  // ruta en el árbol al momento de salir
    NodeSize  uint   `json:"nodesize,omitempty"`  // peso flex previo
    Magnified bool   `json:"magnified,omitempty"`
    CapturedTs int64 `json:"capturedts"`
}

// Estado previo a un Focus para Return con una sola acción.
type FocusSnapshot struct {
    ModuleId   string            `json:"moduleid"`
    WasDetached bool             `json:"wasdetached"`
    Placement  *SpatialPlacement `json:"placement,omitempty"` // si detached
    Dock       *DockMemory       `json:"dock,omitempty"`      // si acoplado (magnify no lo necesita, ver nota)
    CapturedTs int64             `json:"capturedts"`
}

// Memoria de un monitor desaparecido para restaurar si vuelve.
type MonitorMap struct {
    MonitorId   string                       `json:"monitorid"`
    Bounds      *SpatialPlacement            `json:"bounds"`      // bounds del display al partir
    ScaleFactor float64                      `json:"scalefactor"`
    Modules     map[string]*SpatialPlacement `json:"modules"`     // placement original por moduleId
    LostTs      int64                        `json:"lostts"`
}
```

Nota sobre Focus acoplado: magnify no altera `size` en el árbol, por lo que
el "restore" geométrico es gratis (H7). El `FocusSnapshot` igualmente se
persiste para (a) uniformidad de la API `workspace.restoreModule`, (b) el
caso focus-sobre-detached, y (c) auditoría de "volver con una sola acción".

`IndexArr` en `DockMemory` es best-effort: el árbol puede haber cambiado al
volver (bloques cerrados, rebalanceo con reasignación de node ids — gotcha
conocido de `balanceNode`). La restauración usa `insertatindex` con clamp al
árbol vigente; si la ruta ya no existe, cae a `insert` (heurística estándar
de Wave). Esto cumple "restaura su posición previa cuando sea posible".

## 6. Identidad de monitores

Electron `display.id` no es estable entre reinicios en todas las
plataformas. `monitorId` se define como ID compuesto:

```
monitorId = display.label + "|" + display.size.width + "x" + display.size.height + "@" + display.scaleFactor
```

con fallback a `display.id` cuando `label` está vacío. La resolución
`monitorId → display` vigente la hace emain al materializar; ante ambigüedad
(dos monitores idénticos) desempata por bounds más cercanos. Este ID es el
que persiste en `ModuleInstance.MonitorId`, `Surface.MonitorId` y perfiles.

## 7. Perfiles de workspace

Archivo por perfil: `<configdir>/nexus-profiles/<slug>.json`. Sin secretos:
solo IDs, tipos, geometría, monitores y metadatos de vista NO sensibles
(se persiste `meta.view` y claves de presentación; nunca `cmd:env`, tokens,
ni credenciales — lista blanca explícita en CONTRACTS.md §Perfiles).

```json
{
  "schemaversion": 1,
  "name": "Incident Response",
  "createdts": 0,
  "updatedts": 0,
  "workspacename": "…",
  "modules": [
    { "view": "term", "title": "…", "connection": "ssh-host",
      "surfacetype": "mainwindow", "dock": {"indexarr": [0]},
      "placement": null, "monitorid": "" }
  ],
  "surfaces": [ { "type": "detachedwindow", "bounds": {"x":0,"y":0,"width":800,"height":600},
                  "monitorid": "DELL U2723QE|3840x2160@1.5" } ],
  "focusedmodule": "",
  "panels": { "sidebarvisible": true, "widgetsvisible": true }
}
```

Cargar un perfil crea/reubica módulos por **matching declarativo**
(view+connection+title), no por blockId (los OIDs no sobreviven entre
máquinas). Reutiliza `ApplyPortableLayout` para la parte acoplada y el engine
para la parte detached. Idempotencia por nombre, igual que el importador de
workspaces (D-018).

## 8. Versionado y migraciones

Dos niveles, coherentes con el motor:

1. **SQL:** `000012_spatial.up.sql` / `.down.sql` crean/eliminan
   `db_spatial`. Golang-migrate embebido, como las 11 existentes.
2. **Schema JSON:** `SpatialState.SchemaVersion` y `schemaversion` en
   perfiles. `pkg/spatial/migrate.go` aplica migraciones de forma pura
   (`migrateSpatialState(old) → new`) al cargar; ante datos corruptos o
   versión desconocida: se renombra el estado a `Meta["corruptbackup"]`,
   se arranca con estado vacío y se emite warning (recuperación segura,
   requisito de pruebas). Nunca se bloquea el arranque por estado espacial
   inválido.

## 9. Qué NO se persiste

- Secretos/credenciales/env (regla dura).
- `FocusSnapshot` de módulos ya cerrados (GC al cerrar módulo).
- Surfaces detached sin módulos (se destruyen al vaciarse).
- Nada de estado funcional del módulo (eso ya lo persiste el motor:
  block meta, filestore, jobs).
