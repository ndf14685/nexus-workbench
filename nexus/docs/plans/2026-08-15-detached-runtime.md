# Detached Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desacoplar el ciclo de vida de la UI (Electron) del ciclo de vida de ejecución (wavesrv + workers + misiones): cerrar/matar NexusWorkbench.exe no debe interrumpir nada; reabrir debe re-attachear y rehidratar.

**Architecture:** wavesrv gana un modo `--detached` (authkey persistente + state file de rendezvous, sin dead-man switch de stdin) y queda supervisado por una Scheduled Task; Electron attachea a un runtime pre-existente en vez de spawnearlo como hijo. Los workers de Jarvis remotos pasan a jobs durables (`term:durable`) que sobreviven incluso a restarts del runtime. jarvisd gana liveness de canal, fix del race spawn→blocked y notificación por inbox.

**Tech Stack:** Go (wavesrv, nexus/mcp), TypeScript/Electron (emain, frontend), Python (jarvisd en rig3060).

**Spec:** `nexus/docs/adr/ADR-0006-detached-runtime.md` (+ pedido de producto 2026-08-15 §1-45).

## Global Constraints

- Convenciones del repo: `.kilocode/rules/rules.md` (Go sin enums custom, `Make` no `New`, JSON lowercase sin underscores, TS 4 espacios, sin comentarios descriptivos).
- Tests Go con cgo (sqlite) NO corren en Windows local: usar worktree `/tmp/wb-jarvis` en rig3060 (ssh alias `rig3060`, fallback `rig3060-auto`). `nexus/mcp` es Go puro y corre local.
- Frontend: `vitest`, `npx tsc --noEmit`, `npm run build:prod`.
- Nuevos RPC: definir en `pkg/wshrpc/wshrpctypes.go` y correr `task generate` (skill `.kilocode/skills/add-rpc/SKILL.md`). Comandos wsh: skill `add-wshcmd`.
- No romper el modo hijo legacy (dev con `task dev`, plataformas sin task instalada).
- Versión objetivo: `v0.17.0-beta.0` (bump con `node version.cjs`); release desde rig3060 (push main + tag) → GitHub Actions `nexus-windows-package.yml`.
- jarvisd: repo `~/workspace/jarvis-openclaw-desktop` en rig3060; deploy = push main → ff `~/jarvis-canonical` → restart unit (respetando el guard de misiones activas).
- Riesgo documentado y aceptado (ADR-0006): terminales locales no sobreviven a restart del runtime (sí al cierre de la UI).

---

## FASE 1 — Runtime detached (Go / wavesrv)

### Task 1: Estado de runtime persistente (`pkg/wavebase`)

**Files:**
- Create: `pkg/wavebase/runtimestate.go`
- Test: `pkg/wavebase/runtimestate_test.go` (Go puro, corre local)

**Interfaces (Produces):**
```go
const RuntimeProtocolVersion = 1
const RuntimeStateFileName = "runtime.json"
const RuntimeAuthKeyFileName = "runtime.authkey"

type RuntimeState struct {
    Pid      int    `json:"pid"`
    StartTs  int64  `json:"startts"`
    Web      string `json:"web"`
    Ws       string `json:"ws"`
    Version  string `json:"version"`
    Protocol int    `json:"protocol"`
}

func WriteRuntimeState(state RuntimeState) error      // escritura atómica temp+rename en GetWaveDataDir(), 0600
func ReadRuntimeState() (*RuntimeState, error)        // nil, fs.ErrNotExist si no hay
func RemoveRuntimeState()                              // best effort, para doShutdown
func LoadOrCreateRuntimeAuthKey() (string, error)      // lee runtime.authkey; si no existe genera uuid.New().String() y escribe 0600
```

- [ ] Test: `WriteRuntimeState`+`ReadRuntimeState` roundtrip (usar `WAVETERM_DATA_HOME` a un t.TempDir() vía `CacheAndRemoveEnvVars` o seteando el cache del paquete), `LoadOrCreateRuntimeAuthKey` estable entre llamadas, permisos 0600 en POSIX.
- [ ] Implementar; correr `go test ./pkg/wavebase/...` local.
- [ ] Commit `feat(runtime): estado persistente del runtime (state file + authkey)`

### Task 2: Modo `--detached` en wavesrv

**Files:**
- Modify: `cmd/server/main-server.go` (flag, stdinReadWatch condicional, authkey, state file, app-path fallback)
- Modify: `pkg/authkey/authkey.go` (nueva `SetAuthKey(key string)`)
- Modify: `pkg/wavebase/wavebase.go` solo si hace falta exponer el data dir para el fallback

**Detalle:**
1. Parseo simple de `os.Args` en `main()`: `--detached` → `detachedMode = true` (sin libs de flags nuevas).
2. `stdinReadWatch()` solo se lanza `if !detachedMode` (main-server.go:568).
3. Authkey: si `WAVETERM_AUTH_KEY` está en el env se usa como hoy; si no y `detachedMode`, `wavebase.LoadOrCreateRuntimeAuthKey()` + `authkey.SetAuthKey(key)`. Sin env y sin detached → error como hoy.
4. Tras levantar ambos listeners (justo antes del `WAVESRV-ESTART`, main-server.go:606-612): en detached escribir `wavebase.WriteRuntimeState(...)` con las addrs reales, `os.Getpid()`, `WaveVersion`, `RuntimeProtocolVersion`. Mantener el fprintf de `WAVESRV-ESTART` siempre.
5. `doShutdown` (main-server.go:78): agregar `wavebase.RemoveRuntimeState()`.
6. Fallback de app path: en `grabAndRemoveEnvVars`, si `WAVETERM_APP_PATH` viene vacío y detached, derivarlo de `os.Executable()` (el binario vive en `<app>/resources/app.asar.unpacked/bin/`, subir dos niveles hasta `app.asar.unpacked`). Necesario para que el runtime pueda deployar `wsh` a remotos sin el env de Electron.

- [ ] Implementar; verificar compilación por problems de VSCode/gopls (no `go build` manual).
- [ ] Test manual local: `wavesrv.exe --detached` a mano con `WAVETERM_DATA_HOME` a un dir de prueba → aparece `runtime.json` coherente, el proceso NO muere al cerrar stdin, responde en el puerto web.
- [ ] Commit `feat(runtime): modo --detached (sin stdin watch, authkey persistente, runtime.json)`

### Task 3: Health endpoint + shutdown RPC + `wsh runtime`

**Files:**
- Modify: `pkg/web/web.go` (handler `GET /wave/runtime-health`)
- Modify: `pkg/wshrpc/wshrpctypes.go` (+`task generate`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Create: `cmd/wsh/cmd/wshcmd-runtime.go`
- Modify: `cmd/server/main-server.go` (drain real en doShutdown)

**Interfaces (Produces):**
- HTTP `GET /wave/runtime-health` (autenticado con X-AuthKey como todo el web server): `{"ok":true,"version":"...","buildtime":"...","protocol":1,"pid":123,"detached":true}`.
- RPC `ShutdownRuntimeCommand(data CommandShutdownRuntimeData)` con `{"reason":string}` → responde OK y dispara `doShutdown` en goroutine con delay 250ms (que la respuesta RPC salga antes del exit).
- CLI `wsh runtime status` (lee runtime.json + prueba el socket) y `wsh runtime stop`.

**Drain real:** en `doShutdown`, reemplazar `go blockcontroller.StopAllBlockControllersForShutdown()` por una llamada sincrónica con timeout: `StopAllBlockControllersForShutdown` pasa a devolver cuando terminó (WaitGroup interno), envuelta en un `context.WithTimeout(2s)` — si no llega, se sigue igual. Cerrar conexiones SSH explícitamente si `conncontroller` expone un cierre global barato; si no, documentar que caen con el proceso (comportamiento actual).

- [ ] Implementar los tres frentes; `task generate` para tipos TS.
- [ ] Test: unit del handler health (httptest con authkey seteado); manual `wsh runtime status`/`stop` contra el wavesrv de prueba de Task 2.
- [ ] Commit `feat(runtime): health endpoint, shutdown RPC y wsh runtime`

### Task 4: Eventos backend→Electron por WS (adiós stderr)

**Files:**
- Modify: `pkg/eventbus/eventbus.go`
- Modify: `frontend/app/store/wshrpcutil-base.ts` / `emain/emain.ts` (routing del evento en el cliente WS "electron") — investigar primero cómo entrega eventos no-rpc el WS del main process.

**Detalle:** `SendEventToElectron` intenta primero entregar por el canal WS del cliente con `RouteId == "electron"`:
```go
func sendEventToRoute(routeId string, event WSEventType) bool {
    globalLock.Lock()
    defer globalLock.Unlock()
    for _, wdata := range wsMap {
        if wdata.RouteId == routeId {
            select {
            case wdata.WindowWSCh <- event:
                return true
            default:
            }
        }
    }
    return false
}
```
`SendEventToElectron` = `sendEventToRoute("electron", ...)` con fallback al fprintf de stderr actual (modo legacy). Del lado Electron: el handler `handleWSEvent` de `emain.ts:88-123` debe recibir también los eventos que lleguen por el WS del main process (hoy solo los recibe del stderr). Verificar el shape que `WriteLoop` de ws.go serializa para que el parseo coincida con `WSEventType`.

- [ ] Test Go: unit de `sendEventToRoute` con canal registrado/no registrado.
- [ ] Test manual: con app corriendo, crear ventana nueva desde el backend (workspace switch) y verificar que el evento llega por WS (log).
- [ ] Commit `feat(runtime): eventos electron:* por websocket con fallback stderr`

---

## FASE 2 — Attach de Electron (emain)

### Task 5: authkey attach-aware + descubrimiento

**Files:**
- Modify: `emain/authkey.ts` (de const a init explícito)
- Create: `emain/emain-runtime.ts`
- Modify: `emain/emain-wavesrv.ts`, `emain/emain.ts`

**Interfaces (Produces, `emain/emain-runtime.ts`):**
```ts
type RuntimeState = { pid: number; startts: number; web: string; ws: string; version: string; protocol: number };
async function readRuntimeState(): Promise<RuntimeState | null>;      // <dataDir>/runtime.json
async function probeRuntime(state: RuntimeState, authKey: string): Promise<boolean>;  // GET /wave/runtime-health con X-AuthKey, timeout 2s, valida protocol
function readRuntimeAuthKey(): string | null;                          // <dataDir>/runtime.authkey
async function ensureRuntime(): Promise<"attached" | "spawned-legacy">;
```
`ensureRuntime()`:
1. `readRuntimeState()` + `readRuntimeAuthKey()` → probe OK → **attach**: setear `process.env[WSServerEndpointVarName/WebServerEndpointVarName]`, `WaveVersion/WaveBuildTime`, `initAuthKey(keyDelArchivo)`, resolver `waveSrvReady`.
2. Si no: intentar `schtasks /run /tn NexusRuntime` (Windows) o spawn detached directo (`spawn(getWaveSrvPath(), ["--detached"], {detached:true, stdio:"ignore", windowsHide:true, env})` + `unref()`); poll de `runtime.json` cada 250 ms hasta 15 s → attach.
3. Fallback final: `runWaveSrv()` legacy (hijo con stdin watch) y `initAuthKey(randomUUID())` — comportamiento actual intacto.
4. Mismatch de `protocol` → dialog claro + opción de reiniciar runtime (`wsh runtime stop` + relanzar task); nunca attach silencioso incompatible.

`emain/authkey.ts`: `AuthKey` deja de ser const module-level; `initAuthKey(key)` + `getAuthKey()`; `configureAuthKeyRequestInjection` sin cambios de semántica. Actualizar TODOS los imports (`emain.ts:411`, `preload` IPC `get-auth-key`, etc.).

- [ ] Implementar; `npx tsc --noEmit` limpio.
- [ ] Test manual: con wavesrv detached ya corriendo (Task 2), arrancar la app en dev y ver "attached" en logs, terminales funcionando.
- [ ] Commit `feat(emain): attach a runtime detached con fallback legacy`

### Task 6: Desacople bidireccional del quit

**Files:**
- Modify: `emain/emain.ts` (`before-quit` 267-324, `window-all-closed`, guards)
- Modify: `emain/emain-wavesrv.ts` (handler `exit` solo aplica en modo legacy)

**Detalle:**
- Nuevo flag global `runtimeMode: "attached" | "child"` (en `emain-runtime.ts`).
- `before-quit`: si `runtimeMode === "attached"`, NO tocar wavesrv (ni SIGINT ni esperar): solo `updater?.stop()`, `shutdownWshrpc()` y salir. El diálogo de confirmación de quit se reemplaza por el aviso informativo una-sola-vez (§20): config `nexus:runtime:closenotice` en settings; si ya se mostró, cerrar sin preguntar nada.
- Caída del runtime en modo attached: reintentos de attach con backoff (1s→10s) + evento al renderer para banner "Runtime desconectado — reconectando"; NUNCA `app.quit()` automático.
- Modo child (legacy): comportamiento actual intacto.

- [ ] Test manual (dev, modo attached): cerrar app → `Get-Process wavesrv` sigue; reabrir → attach y las terminales locales SIGUEN VIVAS con su proceso (verificar con un `sleep`/`top` corriendo).
- [ ] Test manual: `taskkill /F /IM electron.exe` (dev) → wavesrv sigue.
- [ ] Commit `feat(emain): cierre de UI sin matar runtime + reconexión ante caída`

### Task 7: Scheduled Task `NexusRuntime` (supervisión + migración §41)

**Files:**
- Create: `emain/emain-runtimetask.ts`
- Modify: `emain/emain.ts` (llamada en startup, Windows only)

**Detalle:** `ensureRuntimeTask()`: si `schtasks /query /tn NexusRuntime` falla → crear con XML (para settings de restart): trigger logon del usuario, acción `"<wavesrvPath>" --detached`, `<RestartOnFailure Interval=PT1M Count=3>`, `StartWhenAvailable`, sin elevación (per-user). Si existe pero el path del binario cambió (comparar con `schtasks /query /xml`) → recrear (`/f`). Idempotente, con try/catch que loguea y no rompe el arranque (fallback: spawn detached directo sin supervisor, log warning). En dev (`isDev`) no instalar.

- [ ] Test manual: borrar task → abrir app → task creada; correr de nuevo → no duplica; simular crash del wavesrv (`taskkill /f /im wavesrv.exe`) → Task Scheduler lo relanza en ≤1 min → app re-attachea sola.
- [ ] Commit `feat(emain): supervisión del runtime via Scheduled Task NexusRuntime`

### Task 8: Semántica de cierre explícita + updater seguro (§19, §26)

**Files:**
- Modify: `emain/emain-menu.ts` (items "Shutdown Nexus Runtime"), `emain/updater.ts` (pre-install hook)
- Modify: `emain/emain-runtime.ts` (helper `shutdownRuntime()` vía RPC, `hasActiveMissionBlocks()` vía RPC ListBlocks con meta `nexus:owner=mission` y controller corriendo)

**Detalle:**
- Menú App: "Shutdown Nexus Runtime…" → si `hasActiveMissionBlocks()` → dialog "Hay N sesiones de misión activas" con confirmar/cancelar → `ShutdownRuntimeCommand` → quit app.
- `installUpdate()` (updater.ts:207): antes de `quitAndInstall`, si modo attached: `hasActiveMissionBlocks()` → si hay, dialog "Actualizar igual / Diferir" (diferir = no instalar ahora, `autoInstallOnAppQuit=false` esta sesión); si no hay → `ShutdownRuntimeCommand("update")`, esperar a que `runtime.json` desaparezca (poll 5s) y `quitAndInstall()`. Al arrancar la app nueva, Task 7 recrea/relanza el runtime ya actualizado (path estable).

- [ ] Test manual del menú (sin misiones y con bloque `nexus:owner=mission` fake via setmeta).
- [ ] Commit `feat(emain): shutdown explícito del runtime y update seguro del binario`

---

## FASE 3 — Ownership + workers durables (nexus/mcp + wsh)

### Task 9: `terminal.create` durable + ownership; ADOPT transfiere

**Files:**
- Modify: `nexus/mcp/jarvisagent.go` (execute: create + set_meta)
- Test: `nexus/mcp/jarvisagent_test.go`

**Detalle:**
- `terminal.create` (jarvisagent.go:210-234): al armar el `createblock`, agregar SIEMPRE `meta nexus:owner=mission`; si `connection != ""` (remota), agregar `meta term:durable=true`. Respetar meta extra que ya venga del brain (p. ej. futuro `nexus:headless`).
- `terminal.set_meta` (jarvisagent.go:287-305): si las claves incluyen `jarvis:mission` (ADOPT), inyectar además `nexus:owner=mission` — transferencia de ownership del §10 del spec.
- Tests (patrón de los existentes con `runWsh` fake): (a) create remoto lleva `term:durable=true` y `nexus:owner=mission`; (b) create local NO lleva durable pero sí owner; (c) set_meta con `jarvis:mission` agrega owner; (d) set_meta sin `jarvis:mission` no lo agrega.

- [ ] Tests primero (fallan), implementación mínima, `go test ./...` en `nexus/mcp` local.
- [ ] Commit `feat(jarvis-agent): workers durables remotos y ownership de sesión`

### Task 10: Gobernanza fail-closed cuando no se puede clasificar el entorno

**Files:**
- Modify: `nexus/mcp/jarvisagent.go` (`classForBlock`, jarvisagent.go:76-105)
- Test: `nexus/mcp/jarvisagent_test.go`

**Detalle:** hoy si `blocks list` falla (runtime caído) devuelve `""` → un `terminal.input` destructivo PASA (fail-open). Cambiar: error al clasificar + input destructivo → deny con audit `denied_destructive_unknown_env`. No-destructivo sigue pasando.

- [ ] Test: runWsh fake que falla en `blocks list` + input `rm -rf /` → error, audit correcto; input normal → pasa.
- [ ] Commit `fix(jarvis-agent): deny destructivo cuando el entorno no se puede clasificar`

### Task 11: Headless real: `wsh block park/unpark` + soporte en agente

**Files:**
- Create: `cmd/wsh/cmd/wshcmd-block-park.go` (skill add-wshcmd; wrappea `ParkBlockCommand`/`UnparkBlockCommand` existentes)
- Modify: `nexus/mcp/jarvisagent.go` (`terminal.create` honra `headless:true` del payload → tras crear, `wsh block park <blockid> --note "mission <id>"`)
- Test: `nexus/mcp/jarvisagent_test.go`
- Modify (repo jarvisd, ver Fase 4): `_spawn_worker` pasa `headless` si la misión lo pide.

- [ ] CLI: probar manual `wsh block park/unpark` contra la app dev (los RPCs ya existen y tienen tests Go).
- [ ] Test agente: create con `headless:true` → segundo RunWsh es `block park`; sin flag → no.
- [ ] Commit `feat(headless): worker sin módulo visible via park desde el nacimiento`

---

## FASE 4 — jarvisd (Python, repo jarvis-openclaw-desktop en rig3060)

### Task 12: Fix race spawn→blocked (status `spawning`)

**Files:**
- Modify: `app/missions/engine.py` (`_spawn_worker` :324, `_ensure_progress` :592-596, `start_mission` :107-111)
- Test: `tests/missions/` (nuevo test del race)

**Detalle:** `_spawn_worker` deja el worker en `spawning` (ya definido en `model.py:257`); la primera `_delegate` exitosa lo pasa a `working`. `_ensure_progress` incluye `spawning` en el set de "hay acción en curso" (:592-596) → el tick ya no puede marcar "misión ociosa" entre spawn y primera delegación. Test: simular tick entre `start_mission` y `_delegate` (monkeypatch del canal con latencia) → la misión NO transiciona a blocked.

- [ ] Test primero, fix, `pytest tests/missions -q` verde en rig3060.
- [ ] Commit `fix(missions): race spawn→blocked eliminado usando el status spawning`

### Task 13: Liveness del canal workbench

**Files:**
- Modify: `app/missions/service.py` (`channel_provider` :206-214), `app/missions/engine.py` (`_handle_channel_loss` :421-434)
- Test: `tests/missions/`

**Detalle:**
- `channel_provider`: filtrar clientes workbench con `last_seen` más viejo que 45 s (el SSE pingea cada 15 s → 3 pings perdidos = muerto); entre los vivos, elegir el de `last_seen` más fresco. Sin vivos → `None` (el tick ya transiciona a `recovering`, que se auto-recupera cuando el cliente vuelve).
- `_handle_channel_loss`: tratar `ChannelError(kind="timeout")` como pérdida de canal (→ `recovering`) cuando el cliente elegido está stale; el timeout con cliente fresco sigue siendo solo un evento `error` (puede ser un comando lento).

- [ ] Tests: cliente stale → provider lo saltea; timeout+stale → recovering; timeout+fresco → solo error.
- [ ] Commit `feat(missions): liveness del canal workbench (last_seen) y recovery ante timeouts`

### Task 14: Atención asíncrona por inbox + health de misiones + protocolo

**Files:**
- Modify: `app/missions/service.py` (notify_change → deliver al inbox en transiciones), `app/intelligence/http_api.py` (health, register), `app/intelligence/protocol/__init__.py`
- Test: `tests/missions/`, `tests/intelligence/`

**Detalle:**
1. En `notify_change`, si el snapshot transicionó a `needs_input`/`blocked`/`completed`: `deliver()` al router con destino `workbench` (mensaje corto: nombre humano + reason/result_summary). El inbox persiste en el journal → el Workbench que reabre lo levanta (el overlay ya hace `waitForInboxAnswer`/poll de inbox).
2. `/health`: agregar `"missions": {"active": n, "needs_attention": n}` y `"workbench_channel": {"connected": bool, "staleness_s": x}`.
3. `/clients/register`: aceptar y persistir en la registración `protocol_version` y `agent_version` (opcionales); exponerlos en `GET /clients`. `PROTOCOL_VERSION` del server sube a `"1.4"` y viaja en la respuesta del register.

- [ ] Tests de las tres piezas; `pytest` verde.
- [ ] Commit `feat(missions): inbox dirigido para atención, health de misiones y versión de protocolo en register`
- [ ] Actualizar `nexus/mcp/jarvisagent.go` (repo workbench): mandar `protocol_version` y `agent_version` en el register (payload :109-116) — commit aparte en el repo workbench.

### Task 15: `_spawn_worker` headless passthrough

**Files:**
- Modify: `app/missions/engine.py` (`_spawn_worker`), `app/missions/model.py` (worker spec), `app/missions/workbench.py` (`terminal_create` payload)
- Test: `tests/missions/`

**Detalle:** el spec de worker en `POST /missions` acepta `headless: true`; `_spawn_worker` lo propaga en el payload de `terminal.create` (campo `headless`). El intent NL puede setearlo cuando el pedido diga "en segundo plano"/"sin ventana" (regla en `intents.py` — solo si es barato; si no, queda por API).

- [ ] Test: worker con headless=true → payload de terminal.create lo lleva.
- [ ] Commit `feat(missions): workers headless de nacimiento`

---

## FASE 5 — Rehidratación y UX de reconexión (frontend)

### Task 16: Digest "mientras no estabas" + visibilidad needs_input (§21)

**Files:**
- Modify: `frontend/app/nexus/jarvis/status-model.ts` (o modelo equivalente del indicador de tab bar)
- Test: vitest junto a los tests jarvis existentes

**Detalle:** persistir en localStorage `jarvis:lastseen` (timestamp, actualizado con cada poll con la app en foco). Al arrancar: `GET /missions` → misiones con `updated_at > lastseen` clasificadas: completadas mientras no estabas / necesitan atención / siguen trabajando → toast nativo una sola vez + badge en el indicador ("Jarvis · 2 trabajando · 1 terminó · 1 atención"). Sin spam: un solo toast agregado, no uno por misión. `needs_input` mantiene el badge persistente actual.

- [ ] Test: modelo puro con misiones fixture y lastseen viejo → digest correcto; lastseen fresco → sin digest.
- [ ] `vitest` + `tsc` limpios.
- [ ] Commit `feat(jarvis): resumen de actividad al reconectar y visibilidad de atención`

### Task 17: Banner "runtime desconectado" (renderer)

**Files:**
- Modify: frontend donde vive el status ambiental de tab bar (`frontend/app/nexus/...`), IPC nuevo de emain (`runtime-status-change`) via `emain/preload.ts` + `emain/emain-ipc.ts`

**Detalle:** emain emite `runtime-status-change {status: "connected"|"reconnecting"}` (Task 6); el renderer muestra un banner discreto en la tab bar mientras `reconnecting`. Sin modal, sin bloquear.

- [ ] Test manual: matar wavesrv con la app abierta → banner aparece; el Task Scheduler lo revive → banner desaparece y los bloques resyncan.
- [ ] Commit `feat(frontend): indicador de reconexión al runtime`

---

## FASE 6 — Observabilidad + documentación (§39, §40)

### Task 18: Eventos de observabilidad

**Files:**
- Modify: `pkg/web/ws.go` (log estructurado connect/disconnect ya existe — normalizar mensajes), `cmd/server/main-server.go` (log lifecycle detached), `app/missions/engine.py` (eventos journal `runtime.reconcile`, `worker.recovered`, `worker.orphaned` — los append de eventos ya existen, normalizar nombres)

**Detalle:** asegurar que existan (como log lines en Go y eventos de journal en jarvisd) los equivalentes de: `workbench.client.connected/disconnected`, `runtime.session.created/adopted/reconnected`, `runtime.mission.recovered`, `runtime.worker.recovered/orphaned`, `runtime.reconcile.complete`, `runtime.protocol.mismatch`. Sin secretos en logs (el authkey nunca se loguea).

- [ ] Grep de verificación de cada nombre/equivalente documentado en el ADR.
- [ ] Commit `feat(observability): eventos de lifecycle del runtime y reconciliación`

### Task 19: Documentación

**Files:**
- Modify: `nexus/docs/JARVIS_UX.md` (cerrar deuda "headless auto-park", agregar sección Detached Runtime), `nexus/docs/CHANGELOG.md`, `nexus/docs/ARCHITECTURE.md` (diagrama de procesos post-cambio)
- El ADR-0006 ya está escrito; ajustar si la implementación divergió.

- [ ] Commit `docs: detached runtime (ADR-0006, JARVIS_UX, changelog)`

---

## FASE 7 — Regresión, E2E y release

### Task 20: Regresión completa

- [ ] Local: `vitest` (147+), `npx tsc --noEmit`, `npm run build:prod`, `go test ./...` en `nexus/mcp`.
- [ ] rig3060 `/tmp/wb-jarvis` (detached, rama pusheada): `go test ./pkg/... ./cmd/wsh/...`.
- [ ] rig3060 jarvisd: `pytest` completo.
- [ ] Regresión funcional manual (dev): Ctrl+Space, ADOPT, parking/unpark, badges, browser modules, SSH block, MCP tools (`get_status`, `run_command` remoto con `~`).

### Task 21: Release `v0.17.0-beta.0`

- [ ] `node version.cjs minor true` → commit `release: v0.17.0-beta.0` → merge ff a main EN rig3060 → push main + tag → Actions `nexus-windows-package.yml` → prerelease con `beta.yml`.
- [ ] Recompilar y desplegar `D:\Mcp\nexus-workbench-mcp.exe` y `D:\Mcp\wsh-windows-amd64.exe` (backups `.bak`), reiniciar task JarvisAgent.
- [ ] Deploy jarvisd: push main → ff canónico → restart (guard de misiones respetado).
- [ ] Actualizar la app instalada via "Check for Updates" desde v0.16.0-beta.2 → **AUTO_UPDATE_DETECTED**.

### Task 22: E2E obligatorios (§32-36) sobre la beta instalada

Cada uno con evidencia (transcripts, `Get-Process`, journal de jarvisd):

- [ ] **E2E-1 ADOPT + hard close**: terminal → trabajo → Ctrl+Space "seguí vos con esto" → ADOPT (`nexus:owner=mission`) → cerrar app → `Get-Process NexusWorkbench*` vacío + `Get-Process wavesrv` vivo → misión avanza (journal) → abrir → reconcile → Ver trabajo → scrollback íntegro.
- [ ] **E2E-2 headless**: misión con worker headless → cerrar app → completa → abrir → resultado en digest + inbox → materializar evidencia (unpark).
- [ ] **E2E-3 needs_input**: misión → cerrar app → gate needs_input (journal, detenida segura, sin auto-aprobación) → abrir → atención visible → resolver → continúa.
- [ ] **E2E-4 runtime restart**: misión con worker durable remoto → `wsh runtime stop` + relanzar task → `ReconnectJob` recupera el worker (mismo pid remoto) → misión coherente, sin duplicación. Documentar la clase local no-recuperable con su fail-safe (needs_input).
- [ ] **E2E-5 UI crash**: `taskkill /F /IM NexusWorkbench.exe` con misión corriendo → todo sigue → reabrir → reconcile.
- [ ] Re-correr los E2E pendientes de beta.2 (Ctrl+Space desde terminal, contexto overlay, cwd remoto `~`) — quedaron plegados a esta pasada.

### Task 23: Reporte final + DoD

- [ ] Tabla DoD del spec §43 con evidencia por ítem (nada PASS sin evidencia).
- [ ] Reporte §44 (VERSION/RELEASE/COMMIT/ARCHITECTURE_BEFORE/AFTER/etc.).
- [ ] Actualizar memoria + GBrain con la decisión y el estado.
