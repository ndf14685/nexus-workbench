# Spatial Workspace — Checklist E2E manual (MVP)

- Fecha: 2026-07-31
- Relacionados: TEST_PLAN.md §4, PLAN_MVP.md Task 12, RISKS.md
- Entorno: escritorio real con 2 monitores (los pasos 3, 8 y 10 lo exigen;
  el resto se puede correr con uno). App corriendo con `task dev` o build
  empaquetada.

## Cómo ejecutar comandos durante el checklist

Los comandos se corren desde la devtools de la **ventana principal**
(menú View → Toggle DevTools, o `Ctrl+Shift+I`). Handles reales expuestos
en `frontend/wave.ts`: `window.RpcApi`, `window.TabRpcClient`,
`window.globalStore`, `window.globalAtoms`, `window.WOS`.

Obtener los blockIds (= moduleIds) del tab activo con su vista:

```js
const tabId = window.globalStore.get(window.globalAtoms.staticTabId);
const tab = window.WOS.getObjectValue(window.WOS.makeORef("tab", tabId));
for (const bid of tab.blockids) {
    console.log(bid, window.WOS.getObjectValue(window.WOS.makeORef("block", bid))?.meta?.view);
}
```

Estado espacial persistido del workspace (útil en casi todos los pasos):

```js
await window.RpcApi.SpatialGetStateCommand(window.TabRpcClient, {
    workspaceid: window.globalStore.get(window.globalAtoms.workspaceId),
});
```

La fachada `workspace.*` (CONTRACTS §3, `spatial-api.ts`) mapea 1:1 a estas
RPCs (`workspace.moveModule` ≡ `SpatialMoveCommand`, etc.); no está expuesta
en `window`, así que el checklist usa `RpcApi` directamente.

## Los 10 pasos del MVP obligatorio

### 1. Abrir Terminal + Jarvis + CPU+Mem en la ventana principal

Abrir los tres módulos (launcher/widgets: `term`, `jarvis`, `sysinfo`) en el
tab activo.

- [ ] **Esperado:** los 3 bloques visibles en el árbol del tab; el comando de
  listado de arriba muestra los 3 blockIds con vistas `term`, `jarvis`,
  `sysinfo`.

### 2. Pop Out de Jarvis → misma sesión (tareas mock en curso siguen)

Menú contextual del header del bloque Jarvis → **Desacoplar (Pop Out)**.
Equivalente por comando:

```js
await window.RpcApi.SpatialDetachCommand(window.TabRpcClient, { moduleid: "<blockId-jarvis>" });
```

- [ ] **Esperado:** se abre una ventana propia con Jarvis; la conversación /
  tareas en curso continúan (misma sesión, mismo blockId: verificar con
  `SpatialGetStateCommand` que `modules[<blockId>].isdetached === true` y que
  el blockId no cambió). En la ventana principal el bloque desaparece del
  árbol sin cerrar el tab.

### 3. Mover Jarvis al segundo monitor (menú y comando `workspace.moveModule`)

Por menú: header de Jarvis (en la ventana detached) → **Mover a monitor** →
elegir el segundo. Por comando:

```js
const monitors = await window.RpcApi.SpatialListMonitorsCommand(window.TabRpcClient);
console.log(monitors); // anotar monitorid del segundo monitor
await window.RpcApi.SpatialMoveCommand(window.TabRpcClient, {
    moduleid: "<blockId-jarvis>",
    monitorid: "<monitorId-2>",
});
```

- [ ] **Esperado:** la ventana se traslada al monitor 2 conservando el offset
  relativo (move sin placement); `modules[<blockId>].monitorid` queda con el
  id compuesto del monitor 2 (`label|WxH@scale`).

### 4. Pop Out de CPU+Mem (la serie del gráfico continúa)

Pop Out del bloque `sysinfo` (menú o `SpatialDetachCommand` como en el
paso 2).

- [ ] **Esperado:** el gráfico sigue dibujando la MISMA serie sin reiniciar
  desde cero (datos vía WPS sysinfo: prueba de que no hay proceso duplicado —
  un solo productor, la vista solo se re-monta en la ventana nueva).

### 5. Terminal permanece en la principal; escribir en el shell antes y después

Escribir en el terminal (ej. `echo antes-del-detach`) antes del paso 2 y
otra línea (`echo despues-del-detach`) ahora.

- [ ] **Esperado:** el terminal nunca salió de la ventana principal, el shell
  no se reinició y ambas líneas están en el scrollback.

### 6. Focus sobre Jarvis (desde menú y desde `workspace.focusModule`)

Por menú: header de Jarvis → **Enfocar módulo**. Por comando:

```js
await window.RpcApi.SpatialFocusCommand(window.TabRpcClient, { moduleid: "<blockId-jarvis>" });
```

- [ ] **Esperado:** la ventana de Jarvis pasa al frente con foco del SO. En
  `SpatialGetStateCommand`: `modules[<blockId>].isfocused === true` y hay
  entrada en `focussnapshots[<blockId>]`. Repetir el Focus NO pisa el
  snapshot original (capturedts no cambia).

### 7. Return → posición/tamaño anteriores exactos

Menú → **Restaurar posición anterior**, o:

```js
await window.RpcApi.SpatialRestoreCommand(window.TabRpcClient, { moduleid: "<blockId-jarvis>" });
```

- [ ] **Esperado:** una sola acción devuelve la ventana exactamente a los
  bounds previos al Focus; `focussnapshots[<blockId>]` desaparece (snapshot
  consumido) y el ítem "Restaurar posición anterior" deja de ofrecerse.

### 8. Cerrar Workbench, reabrir → distribución completa restaurada

Cerrar la app entera (Quit, no solo ventanas) y volver a abrirla.

- [ ] **Esperado:** la ventana principal conserva su layout y las ventanas
  detached (Jarvis en el monitor 2, CPU+Mem) se recrean en sus posiciones
  persistidas (reconciliación de emain al arrancar leyendo SpatialState).

### 9. Verificar contenido: el shell del paso 5 conserva el historial escrito

- [ ] **Esperado:** el scrollback del terminal muestra `antes-del-detach` y
  `despues-del-detach` tras el reinicio (el estado del módulo vive en el
  motor, no en la ventana).

### 10. Desconectar monitor 2 → migración; reconectar → restauración

Desenchufar físicamente el monitor 2 (o deshabilitarlo en el SO), esperar
unos segundos, volver a enchufarlo.

- [ ] **Esperado al desconectar:** la ventana de Jarvis migra al monitor
  primario sin quedar inaccesible; `modules[<blockId>].monitorid` queda `""`
  y aparece `monitormemory["<monitorId-2>"]` con el placement original.
- [ ] **Esperado al reconectar:** el mapping se restaura (evento
  `module.moved` + la ventana vuelve al monitor 2 con su placement previo;
  `monitormemory` se limpia). Un Move manual hecho mientras el monitor
  estuvo ausente GANA (no se pisa).

## Variantes obligatorias

### V1. Escalado distinto entre monitores (100%/150%)

Configurar el monitor 2 con 150% de escala y repetir pasos 3 y 8.

- [ ] **Esperado:** la ventana aparece con tamaño correcto en DIP (sin doble
  escala ni ventana gigante/miniatura); el monitorId compuesto incluye el
  scale (`…@1.5`) y el matching al restaurar funciona.

### V2. Bounds negativos (monitor a la izquierda del primario, Windows)

Ordenar el monitor 2 a la IZQUIERDA del primario (coordenadas x negativas)
y repetir pasos 3 y 8.

- [ ] **Esperado:** el placement persiste con x negativa tal cual (nunca se
  "corrige" al guardar) y la restauración valida contra displays reales sin
  mandar la ventana fuera de pantalla.

### V3. Cerrar la ventana detached con la X del SO (= Pop In, módulo no se pierde)

Cerrar la ventana de CPU+Mem con el botón de cerrar del SO.

- [ ] **Esperado:** el módulo NO se pierde: vuelve acoplado a la ventana
  principal en su posición previa (política "cerrar = Pop In"); el bloque
  sigue en `tab.blockids` y desaparece de `modules` en el estado espacial.

### V4. Matar la ventana detached (crash) → módulo rescatado al reiniciar (R6)

Matar el proceso de la ventana detached sin pasar por el cierre normal
(p.ej. `kill -9` del renderer hijo, o el task manager de Chromium con
`Shift+Esc` en esa ventana), luego reiniciar la app si hace falta.

- [ ] **Esperado:** el módulo no desaparece del workspace: al reiniciar, la
  reconciliación de emain recrea la ventana detached desde SpatialState (o,
  si se decide rescatarlo acoplado, reaparece en la principal). Nunca queda
  un bloque huérfano borrado por `cleanuporphaned` (guard R1).

## Fase 4 — perfiles (GATE "Incident Response")

Guardar y recargar la escena completa por nombre:

```js
const wsid = window.globalStore.get(window.globalAtoms.workspaceId);
await window.RpcApi.SpatialSaveProfileCommand(window.TabRpcClient, { name: "Incident Response", workspaceid: wsid });
await window.RpcApi.SpatialListProfilesCommand(window.TabRpcClient); // → ["incident-response"]
await window.RpcApi.SpatialLoadProfileCommand(window.TabRpcClient, { name: "Incident Response", workspaceid: wsid });
```

- [ ] **Esperado:** el archivo `<configdir>/nexus-profiles/incident-response.json`
  existe, sin `cmd:env` ni secretos (lista blanca CONTRACTS §8); cargar el
  perfil dos veces no duplica módulos (matching declarativo por
  view+connection+title) y los módulos detached vuelven a su monitor/placement.
