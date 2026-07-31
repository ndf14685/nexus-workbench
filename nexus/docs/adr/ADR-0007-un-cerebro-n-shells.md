# ADR-0007 — Un cerebro, N shells: el bloque Jarvis es una vista de jarvisd

- Estado: Aceptada (2026-07-31)
- Fecha: 2026-07-31
- Decisores: NDF (operador), Claude (análisis y diseño)
- Relacionados: ADR-0005 (bloque Jarvis), ADR-0006 (Spatial Workspace),
  ADR-0004 (gobernanza), D-021 (AI Providers sin protagonismo), D-024;
  revisión de arquitectura 2026-07-31
  (`~/workspace/docs/2026-07-31-revision-arquitectura-jarvis-workbench.md`);
  ADR gemelo en `jarvis-openclaw-desktop` (mismo texto de decisión, lado
  cerebro; se crea en el M0 de ese repo)

## Contexto

Hoy existen dos Jarvis sin relación entre sí: el cerebro real
(`jarvisd`, daemon Python headless que ya expone HTTP :8770 con bearer
token: /intent, /poll, /llm/*, /state, /tasks, /inbox…) y la maqueta del
Workbench (ADR-0005): un bloque visualmente completo cuyo
`MockJarvisRuntime` guiona 3 escenarios y no piensa. La revisión de
arquitectura 2026-07-31 lo nombró sin eufemismos: bifurcación de
identidad en curso, el Jarvis visible es el que no piensa, y cada
feature nueva del mock es deuda contra la unificación. El ADR-0005 ya
había dejado registrada la deuda de honestidad: el mock no está
etiquetado como preview en la UI.

El bloque Jarvis fue diseñado con un punto de swap explícito: la
interfaz `JarvisRuntime` se instancia en dos líneas de `jarvis-core.ts`.
Este ADR ejecuta ese swap contra el cerebro real.

## Decisión

1. **`jarvisd` es el único cerebro.** Toda cognición, memoria, modo,
   decisión y estado de Jarvis vive en el daemon (:8770). El Workbench
   es una de N shells (junto al HUD PyQt, Telegram vía OpenClaw y los
   clientes futuros): superficies descartables de un mismo estado.
2. **El bloque Jarvis del Workbench es una vista.** `JarvisRuntime` se
   resuelve en construcción: si `nexus:jarvisbrainurl` está configurada,
   `HttpJarvisRuntime` (adapter HTTP contra :8770, bearer token); si no,
   `MockJarvisRuntime` como fallback etiquetado. UI, store, bus y
   context provider no cambian (capas ADR-0005 intactas).
3. **Jarvis Protocol v1 = lo que :8770 ya habla, formalizado.** Canal de
   intención (`POST /intent` con `text/source/session/project`), canal
   de lectura (`/poll`, `/llm/job`, `/inbox?client=`), confirmaciones
   conversacionales (`needs_confirmation` + turno "sí"/"no" del mismo
   `source`, DialogueActResolver) y cancelación (`POST /llm/cancel`).
   El Workbench se identifica con `source="workbench"`. Quedan para M2,
   del lado del cerebro: eventos push (SSE/WS, muerte del polling) y
   registro de capabilities de cliente (`workspace.*` vía contrato). El
   polling a 2000 ms del adapter es transicional y está marcado como tal
   en el código.
4. **El Workbench nunca persiste estado de Jarvis.** Tareas,
   transcripciones y resultados viven en memoria del renderer como caché
   de vista; nada se escribe en block meta, filestore ni settings. Si
   una feature del Workbench necesita memoria o decisión, pertenece al
   cerebro.
5. **Honestidad de superficie (paga la deuda de ADR-0005).** Con runtime
   mock, el bloque muestra un badge persistente "PREVIEW · simulado".
   Con runtime HTTP sin conexión, muestra "cerebro no conectado" con
   reintento. Lo no soportado por el cerebro (editar una acción antes de
   aprobarla, cancelar trabajos no-LLM, progreso real de tareas) se
   reporta como no soportado; nunca se simula éxito.
6. **La voz sigue client-side (mock) por ahora.** El pipeline real de
   voz está acoplado al HUD PyQt; desacoplarlo es M4 del roadmap. El
   `VoiceProvider` del bloque queda mock y cae bajo el mismo badge de
   preview.
7. **Token interino en settings.** `nexus:jarvisbraintoken` viaja en
   texto plano por el config system, igual que el cerebro lo guarda hoy
   (seam blando ya señalado en la revisión). El destino es el secret
   store del Workbench (`wsh secret`, D-015). Se acepta como interino
   por ser LAN local single-user; no es el estado final.

## Alternativas consideradas

- **Fusionar repos / portar el cerebro a TS.** Descartada: meses de
  rewrite sin valor de usuario (rewrite trap de la revisión). Python↔TS
  se unifica hablando el mismo contrato versionado, no compartiendo
  código.
- **Seguir evolucionando el mock como producto.** Descartada: cada
  escenario nuevo agranda la reconciliación futura y compite con la
  identidad del Jarvis real.
- **Empezar por SSE/WebSocket en vez de polling.** Descartada para M1:
  requiere tocar el cerebro (M2). El adapter aísla el mecanismo de
  transporte; cuando exista push, solo cambia el interior de
  `HttpJarvisRuntime`.
- **Borrar el mock.** Descartada: es el fallback de degradación elegante
  (Workbench sin cerebro sigue siendo un IDE completo) y el arnés de
  tests de UX. Queda etiquetado, no promovido.

## Consecuencias

- (+) Un solo Jarvis: lo que el bloque muestra es el estado del cerebro
  real; dos ventanas con Jarvis ven lo mismo porque la verdad está en
  jarvisd (resuelve el singleton-por-renderer señalado en ADR-0006).
- (+) El swap de 2 líneas de ADR-0005 se cobra: UI/store/bus intactos.
- (+) La superficie deja de mentir: preview etiquetado, desconexión
  explícita, operaciones no soportadas visibles.
- (−) Polling transicional a 2000 ms contra /poll y /llm/job hasta M2;
  además /poll es drenante: si otro cliente (HUD) polea a la vez, los
  insights proactivos se reparten entre clientes. Se acepta hasta que el
  cerebro tenga push + inbox por cliente para insights.
- (−) El progreso de tareas LLM no existe en el cerebro: la vista
  muestra progreso 0 (honesto) en lugar de una barra inventada.
- (−) El contexto rico del Workbench (`WorkbenchContext`) aún no viaja:
  /intent solo acepta identidad de sesión y project. El registro de
  capabilities/contexto es M2.
- (−) Token en texto plano en settings hasta migrar al secret store.
