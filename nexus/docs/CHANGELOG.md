# Changelog — Nexus Workbench (fork)

Cambios propios del fork; lo heredado de Wave Terminal se documenta en los
releases de upstream.

## v0.17.0-beta.2 — 2026-08-24 · "Visual Sources" (HMI)

### Agregado
- **Una fuente visual es una clase de objeto del Workbench**, del mismo rango
  que una terminal o un navegador: se configura una vez, se muestra en un
  bloque que dockea/mueve/redimensiona/persiste como cualquier otro, y puede
  ser observada por Jarvis bajo gobernanza explícita. El caso que la motivó es
  una notebook externa entregando su pantalla por HDMI a una capturadora UVC,
  pero nada en la arquitectura sabe qué es un "banco": eso es un label.
- **El provider vive en el jarvis-agent, no en el renderer.** Corre en el host
  donde está el dispositivo y sobrevive al cierre de la UI (ADR-0006): el
  Workbench es consumidor de la fuente, no su dueño. Enumerar, capturar y
  vigilar siguen funcionando con la app cerrada.
- **Bloque HMI** (`view: visual`) con video en vivo, estado de conexión,
  reconexión con backoff, selección de fuente y errores contenidos: que falle
  la capturadora nunca tumba el Workbench.
- **Botón HMI en la botonera.** Presionarlo dos veces no abre dos bloques: un
  device UVC admite un solo consumidor, así que enfoca el que ya existe.
- **Capabilities `visual.sources.list` / `visual.snapshot` / `visual.observe` /
  `visual.watch`**, registradas con su clase de riesgo y proyectadas al registry
  de gobernanza del cerebro (PEP + audit_ref en cada llamada). Ninguna acepta
  "la cámara por defecto": sin `source_id` explícito no hay captura.
- **Ver la señal y dejar que la IA mire son permisos distintos.** El modo
  `aivision` de la fuente (`off` | `on_demand` | `changes`) es independiente de
  tener el bloque abierto: con `off` ni siquiera se abre el dispositivo, y la
  denegación queda auditada. El bloque muestra siempre el indicador.
- **Detección de cambios barata en el agente**: hash perceptual + distancia de
  Hamming + dedup + cooldown antes de molestar a un modelo de visión. El evento
  `visual.change` lleva metadata, nunca el frame; el cerebro decide después si
  el cambio merece una mirada cara.
- **Las fuentes visuales viajan en el contexto del Workbench** (`visual_sources`
  + módulo `visual` del bloque enfocado), que es lo que permite resolver "mirá
  la pantalla del banco" o "mirá esto" contra la fuente correcta.
- `wsh screenshot`: expone por CLI la captura de bloque que el motor ya
  implementaba. Es el único camino posible para obtener un frame mientras el
  viewer humano tiene tomado el device.
- `nexus-workbench-mcp visual devices|list|snapshot`: diagnóstico del provider
  sin abrir la app ni el cerebro.

### Seguridad
- No se graba video ni se persisten frames: el snapshot va a un temporal que se
  borra siempre, y el CLI sin `-out` sólo devuelve metadata.
- El contexto publica metadata; el contenido visual sale únicamente por una
  capability explícita y auditada.
- El permiso de cámara reutiliza el sistema de permisos por origen existente.
- El análisis va por el Observer Fabric del cerebro (routing de proveedores +
  política de privacidad). No se agregaron API keys.

### Notas
- Configuración en `settings.json` bajo `nexus:visualsources` (mismo mecanismo
  que `nexus:environments`, con schema).
- Requiere `ffmpeg` en el host del agente para capturar sin la UI abierta.
- Documentación: `nexus/docs/VISUAL_SOURCES.md`.

## v0.17.0-beta.1 — 2026-08-15

### Arreglado
- **Layout: las ventanas ya no quedan mal distribuidas por nodos fantasma.**
  Los deletes de bloques encolados con la UI cerrada (jarvisd cerrando
  workers, `wsh deleteblock` headless) se descartaban al arrancar la app
  porque se resolvían contra los leafs renderizados (vacíos hasta montar el
  TileLayout); el nodo muerto quedaba persistido como franja colapsada que
  desbalanceaba el resto del tab. Ahora `DeleteNode`/`ReplaceNode`/`Split*`
  caen al árbol directamente, y el `cleanuporphaned` de cada montaje poda
  además los nodos cuyo bloque ya no existe (auto-cura layouts ya rotos).
- Headless/UI cerrada: los bloques creados por agente arrancan su
  controller (`wsh block start`); sin esto nunca ejecutaban ("no controller
  found").
- Park por `wsh`/agente: el remove del nodo de layout se encola
  server-side; el bloque parkeado ya no sigue renderizado tras recargar.
- Cierre de la app ya no cuelga tras el aviso de "el runtime sigue
  corriendo" (closenotice se persiste antes del diálogo, con timeout).
- Exit code real para comandos ssh remotos (SessionWrap + ssh.ExitError).
- `EnsureConnection` tolera conexiones ya conectadas.

## v0.17.0-beta.0 — 2026-08-15 · "Detached Runtime" (ADR-0006)

### Cambiado
- **La UI ya no es dueña de la ejecución.** `wavesrv --detached` corre como
  servicio persistente supervisado por la Scheduled Task `NexusRuntime`
  (logon + restart on failure). Electron ahora ATTACHEA a un runtime
  pre-existente (rendezvous `runtime.json` + `runtime.authkey` en el data
  dir) en vez de spawnearlo como hijo; el dead-man switch de stdin queda
  solo para el modo hijo legacy (dev/fallback). Cerrar o matar
  `NexusWorkbench.exe` no detiene terminales, workers ni misiones.
- **Workers remotos de Jarvis son jobs durables** (`term:durable=true` en
  el `terminal.create` del jarvis-agent): corren bajo `wsh jobmanager`
  (PPID 1) en el host remoto y sobreviven cierre de UI, restart del
  runtime y cortes de red.
- **Semántica de cierre explícita**: X cierra solo la UI (aviso informativo
  una sola vez, `nexus:runtime:closenotice`); "Shutdown Nexus Runtime…"
  en el menú hace drain informado; `wsh runtime status|stop` por CLI; el
  updater detiene el runtime antes de `quitAndInstall` y ofrece diferir si
  hay misiones activas.
- **Ownership de sesión** (`nexus:owner: ui|mission|user`): el spawn de
  workers lo setea y el ADOPT lo transfiere.
- Eventos backend→Electron (`electron:*`) viajan por websocket a la ruta
  `electron`; stderr queda como fallback del modo hijo.

### Agregado
- `GET /wave/runtime-health`, `ShutdownRuntimeCommand`, `wsh runtime`,
  `wsh block park|unpark`; watchdog de re-attach en Electron (runtime
  reiniciado → endpoints nuevos → rewire + relaunch de ventanas).
- Workers **headless** de nacimiento: `headless: true` en el spec del
  worker → bloque parkeado al crearse; "Ver trabajo" lo materializa.
- Digest "mientras no estabas" al reabrir (un solo toast agregado).
- jarvis-agent: deny destructivo fail-closed cuando el entorno no se puede
  clasificar; register con `protocol_version` 1.4 y `agent_version`.
- jarvisd (repo aparte): status `spawning` cierra el race spawn→blocked;
  liveness del canal por `last_seen` (45 s) con recovery ante timeouts;
  atención asíncrona por inbox dirigido; `/health` con resumen de misiones
  y estado del canal.
- `doShutdown` drena los blockcontrollers de verdad (espera con timeout).

## v0.16.0-beta.2 — 2026-08-14 · "Los cinco bugs del E2E"

### Arreglado
- **Contexto del overlay ya no viene vacío** (bug 2): la captura llamaba
  `GetFocusedBlockDataCommand` sin route y caía en el wshserver Go, que no
  lo implementa; ahora rutea al handler del tab (`tab:<tabId>`).
- **Ctrl+Space abre el overlay también con foco en una terminal** (bug 1):
  el dispatcher de atajos resucitaba el `nativeEvent.target` (el TEXTAREA
  oculto de xterm) que el camino de la terminal omitía a propósito, y el
  veto de inputs se comía el atajo. El veto ahora es solo para targets
  explícitos.
- **Las notificaciones nativas de misión llegan** (bug 5): `NotifyCommand`
  iba sin route al wshserver Go (que no implementa `notify`); ahora viaja
  con `route: electron`, igual que `wsh notify`.
- **Un intent que queda "Pensando…" ya no se pierde** (bug 3): jarvisd
  entrega la respuesta async al inbox del cliente `workbench` y nadie la
  leía. El overlay ahora la espera vía `/inbox` y la muestra en la
  conversación — o la entrega como notificación nativa si ya se cerró.
- **`run_command` remoto con cwd funciona de punta a punta** (bug 6):
  `wsh run` mangleaba `~/...` con `filepath.Abs` local; el blockcontroller
  expandía `~` con el home de wavesrv aun con connection remota; y los
  shells remotos/WSL ignoraban `cmdOpts.Cwd` por completo (el comando corría
  siempre en el home). Además el MCP y el jarvis-agent ahora aseguran la
  conexión (`wsh conn connect`) antes de crear bloques remotos: sin eso el
  controller nunca arrancaba y el error solo se veía en la consola del
  frontend.

## v0.16.0-beta.1 — 2026-08-14 · "Restore de parking"

### Arreglado
- **Retomar desde el Parking Lot ahora monta el bloque de verdad.** El
  restore devolvía el bloque a `tab.blockids` y limpiaba `nexus:parked`,
  pero el `waveobj:update` del LayoutState (con el insert pendiente) nunca
  se emitía: el bloque quedaba invisible y huérfano, expuesto al GC.
  `UnparkBlockCommand` ahora difunde los updates acumulados del contexto
  (block + tab + layoutstate), igual que la creación de bloques.
  (Detectado en los E2E reales de §28.)

## v0.16.0-beta.0 — 2026-08-14 · "Jarvis UX: delegación cognitiva"

La evolución integral de ADR-0005: delegar responsabilidad a Jarvis en
lenguaje natural, con contexto capturado automáticamente, y liberar
superficie visual sin perder estado.

### Nuevo
- **Ctrl+Space — Jarvis global**: overlay conversacional invocable desde
  cualquier módulo (también con foco dentro de ChatGPT/YouTube/terminal),
  Escape cierra, comando `jarvis.open` editable en el registry.
- **Contexto automático (`JarvisContext`)**: al invocar Jarvis desde una
  terminal viaja cwd, conexión, repo (inferido por los `workspaces` del
  catálogo), estado del shell, último comando/exit code y tail del
  scrollback (con `scrubSecrets`); desde un módulo web viaja url/título.
- **Lenguaje natural sobre misiones** (cerebro jarvisd): observe / continue /
  take_ownership / supervise / query / stop / pause / resume, con nombres
  humanos de misión (`Mission.name`), desambiguación conversacional y
  fail-safe (ambigüedad pregunta, jamás ejecuta).
- **ADOPT**: "seguí vos con esto" adopta la terminal actual (el engine
  reutiliza el bloque taggeado y hereda su conexión real) en vez de abrir
  una nueva.
- **Parking**: "guardá esto para después" o el menú `…` del bloque sacan el
  módulo de la superficie sin perder su estado (Block + scrollback +
  procesos Go quedan intactos; inmune al GC de huérfanos); Parking Lot en
  el overlay con Retomar/cerrar; sobrevive reinicios.
- **Status ambiental**: indicador discreto en la tab bar ("Jarvis · N
  trabajando · M atención"), badge `● Jarvis` en bloques con misión.
- **Notificaciones solo-atención**: nativas, únicamente en
  completed/failed/needs_input/blocked, con el resultado humano
  (`result_summary`) — nunca pasos internos.
- **Gobernanza en jarvis-agent** (cierra la asimetría con ADR-0004 §2):
  input destructivo sobre ambientes `prod` se deniega en el Workbench y
  toda capability de escritura se audita en `nexus-mcp-audit.jsonl`.
- Config unificada del brain: setting `nexus:brainurl` + token en el secret
  store (formulario de primera vez en el overlay).

### Arreglado
- Los atajos `Ctrl+Alt+*` del fork ahora funcionan con el foco dentro de un
  webview (bug de mayúsculas en los descriptores: `Ctrl:Alt:J` implicaba
  Shift para keyutil) y dentro de xterm (el keydown del terminal salteaba
  el dispatcher del fork).
- La lista de teclas interceptadas en main se refresca al reasignar atajos
  (antes quedaba stale hasta reiniciar).
- El release sube `*.blockmap`: el auto-update vuelve a ser diferencial.

### Deuda conocida (ver `nexus/docs/JARVIS_UX.md`)
- HEADLESS automático (auto-park del worker) — el park manual del worker ya
  funciona con la misión corriendo.
- Intents de misión solo por HTTP `/intent` (HUD/voz TCP pendiente).
- Cierre automático de módulos al completar misión: solo notificación
  (conservador a propósito).
