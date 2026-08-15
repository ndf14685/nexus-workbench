# ADR-0006: Detached Runtime and Persistent Execution

- Estado: Aceptada
- Fecha: 2026-08-15

## Contexto

Hoy la UI es dueña de la ejecución. La cadena de propiedad real, verificada
en discovery (2026-08-15), es:

```
NexusWorkbench.exe (Electron main)
  └─ wavesrv (hijo directo, stdio en pipes)      emain/emain-wavesrv.ts:75
       ├─ PTYs locales (ConPTY)                  pkg/shellexec/shellexec.go:719
       ├─ ssh.Client → sshd remoto
       │    └─ wsh connserver (hijo de sshd)     conncontroller.go:432
       │         └─ shell del worker → claude/codex
       └─ SQLite waveterm.db + filestore.db      (esto sí persiste)
```

Al cerrar la app en Windows no hay siquiera un kill: Electron sale, el pipe
de stdin de wavesrv se cierra, y `stdinReadWatch` (`cmd/server/main-server.go:100`)
dispara `doShutdown` → `StopAllBlockControllersForShutdown` mata todas las
terminales, las conexiones SSH caen por terminación de proceso, sshd mata la
sesión remota y con ella el connserver y los shells de los workers de Jarvis.
El acoplamiento es bidireccional: si wavesrv muere, Electron se autocierra
(`emain-wavesrv.ts:79-87`).

Los bloqueos concretos para re-attach hoy:

1. **Sin descubrimiento**: los puertos son efímeros (`127.0.0.1:0`) y solo se
   anuncian por el stderr del hijo (`WAVESRV-ESTART`, `main-server.go:611`).
2. **Authkey irrecuperable**: `crypto.randomUUID()` por arranque de Electron
   (`emain/authkey.ts:9`), solo en RAM, empujado al hijo por env.
3. **`wave.lock`**: un segundo wavesrv muere al no obtener el flock
   (`main-server.go:504`), y su muerte autocierra la app.
4. **Eventos backend→Electron por stderr** (`eventbus.SendEventToElectron`).

Activos que el discovery confirmó y que este ADR explota:

- El backend ya es **multi-cliente** por websocket (`stableid`, con semántica
  de reemplazo — `pkg/web/ws.go:222-251`). No hay asunción de cliente único.
- El scrollback ya persiste en `filestore.db` (ring 2 MiB por terminal,
  flush cada 5 s) y el frontend ya lo rehidrata al montar un bloque.
- Ya existe el modelo de **jobs durables**: `wsh jobmanager` daemonizado
  (setsid, PPID 1) + `DurableShellController` + `ReconnectJob` con
  verificación PID+startTs. Solo aplica a conexiones remotas POSIX y hoy
  está apagado por settings (`term:durable: false` global); el meta de
  bloque lo enciende por bloque (`jobcontroller.go:1348-1391`).
- jarvisd persiste el MissionStore en SQLite y ya tiene `recover_all()`;
  jarvis-agent ya corre como Scheduled Task independiente de Electron.

## Decisión

### 1. wavesrv se convierte en el Nexus Runtime, desacoplado de Electron

Se introduce un **modo detached** (`wavesrv --detached`):

- **No** arranca `stdinReadWatch` (el dead-man switch de stdin queda solo
  para el modo hijo legacy).
- Genera o carga un **authkey persistente** en `<dataDir>/runtime.authkey`
  (0600) cuando `WAVETERM_AUTH_KEY` no viene en el entorno.
- Escribe un **state file** `<dataDir>/runtime.json` (escritura atómica
  temp+rename, 0600) con `{pid, startts, web, ws, version, protocol}`.
  `WAVESRV-ESTART` por stderr se mantiene por compatibilidad.
- `wave.lock` conserva su semántica: garantiza un único runtime por data dir.

Electron al arrancar: lee `runtime.json` → valida (pid vivo + probe HTTP
autenticado con el authkey del archivo) → **attach**. Si no hay runtime
sano: lo lanza vía el supervisor (ver §3) o, como fallback, spawn detached
directo, y espera el state file. El renderer no cambia: sigue leyendo
`WAVE_SERVER_WS_ENDPOINT`/`WAVE_SERVER_WEB_ENDPOINT` del main process.

Desacople bidireccional:
- Cerrar la app **no** toca al runtime (se elimina el kill/cierre de stdin
  del path de quit cuando el modo detached está activo).
- Si el runtime cae, la app **no** se autocierra: muestra estado
  "desconectado" y reintenta attach con backoff.

### 2. El canal backend→Electron deja stderr

`eventbus.SendEventToElectron` pasa a publicar por el websocket a la ruta
estable `electron` (el main process ya es un cliente WS con ese stableid).
Los RPC que dependen de la ruta `electron` (secretstore, focus, diagnóstico)
degradan con error explícito cuando no hay ningún cliente Electron
conectado; no se rediseña el secretstore en esta evolución.

### 3. Supervisión

- **Windows**: Scheduled Task `NexusRuntime` (trigger al logon, restart on
  failure), mismo patrón que `JarvisAgent`. Corre `wavesrv --detached` en la
  sesión del usuario (necesario: ConPTY, llaves SSH, PATH, secretos de
  usuario; un Windows Service en Session 0 rompería todo eso). La app
  instala/actualiza la task idempotentemente al arrancar (migración
  automática §41 del spec: `schtasks /create /f`, sin elevación por ser
  per-user). Lifecycle explícito: start = schtasks run / logon; health =
  `runtime.json` + probe; stop = RPC de shutdown graceful; restart = stop +
  schtasks run; upgrade = ver §6.
- **Linux (rig3060)**: sin cambios de topología. jarvisd ya es systemd user
  unit; los workers durables quedan bajo `wsh jobmanager` (PPID 1, modelo
  upstream de Wave). No se agrega ningún daemon nuevo.

### 4. Ownership de sesiones y ADOPT

Meta de bloque nuevo: **`nexus:owner`** ∈ `ui | mission | user`.

- `terminal.create` del jarvis-agent lo setea a `mission`; el ADOPT
  (set_meta de `jarvis:mission` sobre bloque existente) también transfiere
  `nexus:owner=mission`.
- Con runtime detached, *toda* sesión sobrevive al cierre de la UI (el
  proceso es del runtime, no de la ventana). El ownership no decide
  supervivencia al cierre de UI sino: (a) qué avisa el diálogo de cierre,
  (b) prioridad de rehidratación al reabrir, (c) qué protege el drain del
  shutdown explícito del runtime.
- El runtime vive lo que la sesión del usuario (logon→logoff), no es un
  daemon eterno: una shell UI-owned ociosa es un proceso ocioso, no deuda.

### 5. Workers durables (la palanca principal para misiones)

`terminal.create` del jarvis-agent agrega `term:durable=true` al meta cuando
la conexión es remota. Resultado: el shell del worker corre bajo
`wsh jobmanager` daemonizado en rig3060 y sobrevive a: cierre de la UI,
reinicio de wavesrv, caída de red (reconexión por `ReconnectJob` con
PID+startTs). Los workers locales quedan como `ShellController` hijos del
runtime persistente: sobreviven al cierre de la UI pero **no** a un restart
del runtime — clase documentada con fail-safe (recovery → `needs_input`),
según §35 del spec.

### 6. Upgrades

- La app se sigue auto-actualizando (electron-updater). Antes de
  `quitAndInstall`: si no hay misiones activas → RPC de shutdown graceful al
  runtime (libera el exe para NSIS), instala, y al arrancar la app nueva el
  runtime se relanza actualizado (path del binario estable entre versiones).
  Si hay misiones activas → se difiere el update del runtime (la app puede
  actualizarse en el próximo idle) — espejo del guard de
  `update_jarvis_canonical.sh` en rig3060.
- Compatibilidad: `runtime.json` lleva `version` + `protocol` (entero).
  Electron compara: protocolo distinto → ofrece reiniciar el runtime (que ya
  apunta al binario nuevo); nunca falla silencioso.

### 7. jarvisd: reconciliación y liveness (repo jarvis-openclaw-desktop)

1. **Race spawn→blocked**: `_spawn_worker` usa el status `spawning` (ya
   definido en el modelo, nunca usado) hasta la primera delegación;
   `_ensure_progress` trata `spawning` como progreso.
2. **Liveness del canal**: `channel_provider` elige el cliente workbench con
   `last_seen` más fresco y descarta stale (>45 s); `ChannelError(timeout)`
   con cliente stale dispara `_handle_channel_loss` en vez de degradar en
   silencio.
3. **Atención asíncrona**: las transiciones a `needs_input`/`blocked`/
   `completed` publican además al inbox dirigido (`deliver()`), que ya
   existe y persiste en el journal — el Workbench que reabre lo encuentra.
4. **Protocolo**: `/clients/register` acepta y guarda `protocol_version` y
   `agent_version`; `/health` expone resumen de misiones + estado del canal.

### 8. Semántica de cierre (UI)

- **X / Close Workbench**: cierra solo la UI. Primera vez muestra aviso
  informativo ("Jarvis y las tareas delegadas siguen trabajando en segundo
  plano") con "no volver a mostrar" (`nexus:runtime:closenotice`). Sin
  advertencias alarmistas.
- **Stop Mission**: existente (`POST /missions/<id>/stop`).
- **Shutdown Nexus Runtime**: acción explícita de menú → drain (avisa si hay
  sesiones mission-owned activas) → shutdown graceful del runtime.
- Crash de la UI (`taskkill /F /IM NexusWorkbench.exe`) ≡ cierre: el runtime
  no depende de ningún shutdown hook de Electron.

### 9. Rehidratación al abrir

Startup: attach → fetch misiones (`/missions`) + parked (`ListParkedBlocks`)
+ inbox. Reglas: ACTIVE previamente visible → se restaura (el layout
persistido ya lo hace; ahora el proceso además está vivo); ACTIVE headless →
solo status Jarvis; PARKED → Parking Lot, no se abre; COMPLETED → resumen
"mientras no estabas", sin materializar terminal; NEEDS_INPUT → alta
visibilidad en el indicador Jarvis. No se abren módulos en masa: la única
materialización automática es la del layout que el usuario dejó.

## Consecuencias

- El modelo mental queda: Workbench = cockpit descartable; Runtime =
  servicio persistente; jarvisd = supervisor; workers = ejecución durable;
  stores SQLite = memoria operacional.
- El modo hijo legacy (spawn con stdin-watch) se conserva como fallback
  (dev, plataformas sin task instalada), activado solo cuando el attach y el
  supervisor fallan.
- Riesgo aceptado y documentado: terminales **locales** no sobreviven a un
  restart del *runtime* (sí al de la UI). Extender jobmanager a
  local+Windows queda como deuda explícita.
- Riesgo de seguridad preexistente documentado: `nexus/mcp` acuña JWTs
  leyendo la clave Ed25519 de `waveterm.db`; cualquier proceso con lectura
  de la DB puede emitir tokens. Mismo dominio de confianza (usuario local),
  sin cambio en esta evolución; hardening (DPAPI/keyring) queda como deuda.
- `runtime.authkey` y `runtime.json` viven en `%LOCALAPPDATA%` con ACL de
  usuario + 0600; los listeners siguen en loopback exclusivamente; no se
  expone nada nuevo a la LAN.

## Referencias

- Spec de producto: pedido "Detached Runtime" 2026-08-15 (secciones 1-45).
- Discovery: informes emain / wavesrv / jarvis-agent / jarvisd (2026-08-15).
- Plan de implementación: `nexus/docs/plans/2026-08-15-detached-runtime.md`.
- ADR-0005 (Jarvis UX), `nexus/docs/JARVIS_UX.md`,
  `docs/architecture/adr-mission-supervisor.md` (repo jarvisd).
