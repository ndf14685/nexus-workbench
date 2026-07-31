# Spatial Workspace — Alcance del MVP y backlog posterior

- Fecha: 2026-07-30
- Relacionados: ADR-0006, MIGRATION_PLAN.md, TEST_PLAN.md

## Dentro del MVP

| Capacidad | Criterio de aceptación |
|---|---|
| Desacoplar cualquier módulo (Pop Out) | El mismo blockId se monta en ventana propia; shell/estado/contexto intactos; sin duplicar procesos |
| Mover a otra ventana/monitor | Menú "Move to Monitor" + `workspace.moveModule`; conserva offset relativo |
| Volver a acoplar (Pop In) | Restaura posición previa best-effort (`DockMemory`); cerrar la ventana = Pop In |
| Focus / Return | Snapshot previo; acoplado = magnify (resto atenuado, ya nativo); detached = al frente; Return en una acción |
| Maximize / Minimize por módulo | Acoplado: magnify / ocultar-minimizado; detached: maximize/minimize de ventana |
| Persistencia y restauración | otype `spatial` versionado (migración 000012); al reiniciar se recrean ventanas detached en su monitor |
| Multi-monitor seguro | Catálogo de monitores, listeners de display, reconciliación ante monitor ausente con memoria de retorno; DIP + scaleFactor guardado |
| Event bus | WPS `spatial:update` + `spatial-bus.ts` tipado; cero polling |
| API Jarvis | `workspace.focusModule/moveModule/restoreModule/detachModule/attachModule/saveLayout/loadLayout/listMonitors` |
| Perfiles | Guardar/cargar/listar perfiles nombrados (módulos, superficies, monitores, geometría, foco, visibilidad de paneles), sin secretos |
| Módulos de demostración | Terminal, Jarvis, CPU+Mem — checklist de 10 pasos (TEST_PLAN §4) |

## Fuera del MVP (explícito)

- XR/AR/Web/Remote renderers (solo reservas de modelo e interfaz).
- Reconocimiento de voz (la API de comandos es el entregable).
- Multi-módulo por ventana detached (modelo lo admite; UI no).
- Mostrar el mismo módulo en dos superficies a la vez (el routing lo
  permite a futuro vía routes `feblock:`; no en MVP).
- Drag & drop de bloques entre ventanas (MVP usa menú/comandos).
- Runtime real de Jarvis (sigue mock, ADR-0005); ejecución de comandos por
  voz o NLU.
- Mover módulos entre tabs de la ventana principal.
- Gobernanza ADR-0004 sobre comandos espaciales (los comandos son de bajo
  riesgo; se integra cuando Jarvis ejecute acciones reales).

## Backlog posterior (ordenado)

1. **B1 — Runtime Jarvis backend-side** (resuelve R9): estado compartido
   entre ventanas; adapter OpenClaw/MCP reemplaza el mock (2 líneas,
   ADR-0005).
2. **B2 — Drag & drop espacial**: arrastrar un bloque fuera de la ventana
   = Pop Out al soltar (usa el pending-action ya existente + tracking de
   cursor entre displays).
3. **B3 — Multi-módulo por surface**: mini-layout (árbol flex reusado) en
   ventanas detached; "Poné Security al lado de Kubernetes".
4. **B4 — Ack/CAS del drenado de acciones de layout** (resuelve R2 de
   fondo).
5. **B5 — NLU de comandos Jarvis**: mapear frases ("mandá logs al monitor
   izquierdo") a `workspace.*`; monitor por posición relativa
   (izquierda/derecha calculado desde bounds).
6. **B6 — Perfiles avanzados**: auto-perfil por evento (incident response
   al disparo de alerta), export/import entre máquinas.
7. **B7 — Módulos nuevos**: Logs, Kubernetes, Security Center, Grafana
   (web view gobernada), Git, Tasks — cada uno un view type estándar; el
   sistema espacial los hereda gratis.
8. **B8 — Límite y descarga de surfaces** (R14): cap configurable,
   suspender renderers minimizados.
9. **B9 — WebRenderer**: workbench remoto en browser (surface remota sobre
   el mismo wavesrv).
10. **B10 — XRRenderer** (visión): implementación de `WorkspaceRenderer`
    sobre WebXR; el modelo ya reserva z/rotation/depth/anchor/spatialScale.
