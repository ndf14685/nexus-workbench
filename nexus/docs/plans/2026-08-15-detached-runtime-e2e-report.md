# Reporte E2E + DoD — Detached Runtime (§43/§44)

**Fecha:** 2026-08-15 · **Sesión:** E2E post-update sobre la app instalada

## §44 — Reporte

- **VERSION:** 0.17.0-beta.0 (build 202608150719)
- **RELEASE:** prerelease `v0.17.0-beta.0` en GitHub (Actions run 31871399761, exe+msi+zip+SBOM+SHA256SUMS+beta.yml)
- **COMMIT (release):** `be888782` (main) — tag `v0.17.0-beta.0`
- **COMMITS POST-RELEASE (branch `feature/detached-runtime`, para beta.1):**
  - `841d7851` fix(mcp,jarvis-agent): EnsureConnection tolera conexión ya establecida
  - `b872e630` fix(shellexec): exit code real para sesiones ssh (SessionWrap pointer receivers + `*ssh.ExitError` en ExitCodeFromWaitErr)
  - `44560156` fix(jarvis-agent,wsh): `wsh block start` — arrancar controller de bloques creados sin frontend
  - `7e1ba283` fix(emain): quit colgado tras aviso de cierre + `jarvis.away_digest` en telemetría (tsc)
  - jarvisd: `afe58fa` fix(missions): anotar criterios audit en el prompt del evaluador (deployado en canónico)
- **ARCHITECTURE_BEFORE:** wavesrv hijo de Electron con dead-man switch de stdin (`main-server.go:100`); cerrar la UI cortaba el pipe y toda ejecución moría con ella (en Windows, además, sin señal de cierre limpio). Workers de misión = procesos hijos de ese wavesrv.
- **ARCHITECTURE_AFTER:** `wavesrv --detached` como servicio persistente (Scheduled Task `NexusRuntime`, at-logon), rendezvous por `<dataDir>/runtime.json` + `runtime.authkey`; Electron attachea (`runtime mode: attached`) y su cierre no toca el runtime. Workers remotos durables bajo jobmanager (PPID 1 en el host remoto) sobreviven además el restart del propio runtime.

### Verificaciones de arranque (post-update)

| Check | Resultado | Evidencia |
|---|---|---|
| AUTO_UPDATE_DETECTED (beta.2 → 0.17.0-beta.0 vía Check for Updates) | PASS | app instalada reporta 0.17.0-beta.0; `runtime.json` `"version":"0.17.0-beta.0"` |
| Primer arranque spawnea runtime detached | PASS | waveapp.log `05:43:13 runtime spawned detached, pid 30692` + `runtime mode: attached` |
| Task `NexusRuntime` instalada | PASS | `schtasks /query /tn NexusRuntime` → Ready, at-logon, comillas correctas |
| Reapertura attachea al runtime EXISTENTE (sin respawn) | PASS | waveapp.log `06:15:48 runtime mode: attached` sin línea de spawn; mismo pid 30692 todo el día |
| Cierre de UI no mata ejecución | PASS | la propia sesión Claude (bloque local, nieta de wavesrv) sobrevivió 2 cierres graceful + 1 taskkill de la UI |
| Cierre limpio con `closenotice` seteado | PASS | WM_CLOSE → 0 procesos Electron en ~12s, wavesrv intacto |

## §32-36 — E2E obligatorios

### E2E-1 ADOPT + hard close — PASS (m-806c30428a)

Terminal ssh rig3060 creada con trabajo pendiente → `Ctrl+Space` **con foco en la terminal** (re-verifica bug 1 de beta.2) → "segui vos con esto" → ADOPT: contexto capturado con cwd + último comando + salida reciente (re-verifica bug 2), `reused_block: true` sobre el bloque exacto (`b8b2a087`), `nexus:owner=mission` → **cierre de app** (0 procesos Electron, wavesrv 30692 vivo) → la misión avanzó con UI cerrada (journal: delegación → observación → 2º paso → completed con DoD evidenciado) → scrollback íntegro en el bloque (2 pasos `claude -p` con JSON y sentinels `JARVIS_STEP:51ae1:0`, `JARVIS_STEP:51ae2:0`) → bloque adoptado NO se auto-cerró (correcto §17: adoptado es del usuario).

Nota de calidad (no bug de maquinaria): la captura de "salida reciente" ya no incluía el marcador (scrolleado por un `cd` posterior); el worker eligió el TODO.md del repo y lo verificó con evidencia byte a byte. Decisión razonable con el contexto que recibió.

### E2E-2 headless — PASS (m-6c75d001ce)

Misión creada y arrancada **con la UI cerrada**: spawn de worker headless (bloque parkeado de nacimiento, `term:durable`, controller arrancado server-side por el fix `wsh block start`) → archivo `/home/ndf/workspace/e2e-jarvis-ux/e2e2-headless.txt` creado con contenido exacto `headless-ok` → completed con DoD evidenciado (salida literal de `ls`/`cat`/`wc`) → §17 cerró el bloque parkeado al completar (verificado: block not found) → notificación de completion retenida en el inbox dirigido `workbench` mientras la UI estaba cerrada.

Nota de diseño: "materializar evidencia (unpark)" del plan no aplica tal cual — §17 cierra el bloque headless al completar; la evidencia se materializa vía `result_summary` + inbox + digest. Si se quiere conservar el bloque para inspección, haría falta eximir headless del cierre §17 o materializar antes de la transición (decisión de producto pendiente).

### E2E-3 needs_input — PASS (m-3031726526)

Misión con DoD `assertion` + `audit` (sin reviewer), worker headless rig3060, creada y corrida **con la UI cerrada**: worker creó `e2e3ter-gate.txt` (= `gate-ok`) → evaluador `done` (1 paso, post-fix `afe58fa`) → engine gateó `needs_input` "el DoD exige auditoría pero no hay reviewer" — **detenida segura, sin auto-aprobación**, journal completo (spawn → delegation → observation → verdict done → needs_input). Al reabrir la app: **tab bar "Jarvis · 1 atención" visible** (captura `e2e3-reopen3.png`) e ítem retenido en inbox. `resume` NO auto-aprueba (vuelve al gate en el siguiente tick). Resolución humana: auditoría manual del archivo (contenido exacto verificado) + cierre explícito.

Además quedó el camino no-determinístico evidenciado antes: `needs_input` "worker implementer estancado" (m-63f94bda5d) también disparó con la app cerrada y quedó en inbox.

### E2E-4 runtime restart — disparado al cierre de esta sesión (m-3eaffb5495)

Misión heartbeat en rig3060 (worker durable: jobmanager remoto `1634109` → `claude -p` `1634445` → loop bash `1634984`, apendeando `hb <epoch>` cada 10s a `e2e4-heartbeat.log`). Runner externo: task `NexusE2E4` → `D:\Mcp\e2e4-runtime-restart.ps1` → `wsh runtime stop` + relanzar `NexusRuntime` + evidencia a **`D:\Mcp\e2e4-evidence.txt`** (pids pre/post, runtime.json, jobdebug list, `ps` de los pids remotos). La sesión Claude que orquestó esto muere con el stop (terminal local, deuda documentada — el fail-safe es su clase). **Validación post-hoc**: (a) evidencia del runner; (b) `e2e4-heartbeat.log` con 30 líneas de timestamps ~10s SIN CORTES a través del restart; (c) misión m-3eaffb5495 completada coherente, sin duplicación de workers.

### E2E-5 UI crash — PASS (m-6a8d70900a)

Misión heartbeat corriendo (worker `working`) → `taskkill /F /IM "Nexus Workbench.exe"` → 0 procesos Electron, wavesrv 30692 intacto, **heartbeat siguió avanzando (6 → 10 líneas en 45s sin UI)**, misión `running` ininterrumpida → relanzada la app: `runtime mode: attached` (06:37:30, mismo wavesrv), reconcile completo — tab bar "Jarvis · 1 trabajando · 1 atención", panel Jarvis con la misión RUNNING y la atención pendiente (captura `e2e5-reopen.png`), worker siguió `working` de punta a punta.

### Re-runs beta.2 — PASS

- **Ctrl+Space desde terminal (bug 1):** PASS — overlay abrió con foco en terminal xterm; el intent llegó a jarvisd (dos veces: m-63f94bda5d y m-806c30428a).
- **Contexto del overlay (bug 2):** PASS — objective con "Contexto de la terminal: cwd …; último comando …; Salida reciente …" y ADOPT del bloque correcto.
- **cwd remoto `~` (bug 6):** PASS — `run_command` rig3060 con cwd `~/workspace` → `pwd` = `/home/ndf/workspace`.

## Bugs encontrados y arreglados en esta pasada

1. **EnsureConnection fallaba con conexión ya conectada** (`cannot connect ... when status is "connected"`): el 2º run_command remoto y todo spawn remoto con conexión viva morían. Fix `841d7851` (MCP + jarvis-agent), test `TestTerminalCreateToleratesAlreadyConnected`. Desplegado en D:\Mcp.
2. **Exit code -1 en TODO comando ssh remoto** (éxito incluido): `SessionWrap` con receivers por valor perdía `WaitErr` (cada llamada opera sobre una copia) y `ExitCodeFromWaitErr` no conocía `*ssh.ExitError`. Camino recién visible desde el fix de cwd de beta.2 (antes esos bloques ni arrancaban). Fix `b872e630`; go test verde en rig3060. **Ships en beta.1** (el wavesrv instalado sigue mostrando "-1").
3. **Bloques creados sin frontend no tenían controller** ("no controller found" al primer input): el controller lo arranca el frontend al renderizar; headless (parkeado) o con UI cerrada, nunca. Rompía TODOS los workers headless y cualquier spawn con UI cerrada — la promesa central del Detached Runtime. Fix `44560156`: nuevo `wsh block start` (ControllerResyncCommand) invocado por el agente tras cada createblock (idempotente). Desplegado (agente + wsh de D:\Mcp).
4. **Quit de Electron colgado tras el aviso §20** (proceso vivo sin ventanas, `closenotice` sin persistir): el `SetConfigCommand` post-diálogo podía no resolver nunca con la última ventana destruida; `electronApp.quit()` inalcanzable. Aislado empíricamente (con flag preseteado el quit tarda ~12s y es limpio). Fix `7e1ba283`: persistir antes del diálogo con timeout 2s. **Ships en beta.1.**
5. **tsc roto en el release** (`jarvis.away_digest` fuera de `JarvisTelemetryEvent`, introducido por `4dcfeee8`): corregido en `7e1ba283`.
6. **Park sin frontend dejaba el nodo en el layout**: el nodo lo removía solo el frontend (menú contextual); un park via wsh (headless o UI cerrada) dejaba el bloque parkeado renderizado tras recargar (visto al reabrir: worker de m-3031726526 visible pese a `nexus:parked=true` y fuera de `tab.blockids`). Fix `79c42097`: acción `delete` encolada server-side (patrón DeleteBlock/Unpark), test en `wshserver_parking_test.go`. **Ships en beta.1.**
7. **Evaluador loopeaba con criterios `audit`** (m-f057ddfac5: "next" eterno pidiendo al worker conseguir aprobación humana): el prompt listaba el criterio audit como pendiente con la regla "done solo si TODOS", contradiciendo la exclusión del código. Fix jarvisd `afe58fa` (deployado + restart; pytest 1567 passed).

## Bugs/deudas documentados (NO arreglados)

- **Workers local-windows nunca funcionaron** (dos capas): (a) la delegación por `terminal.input` termina en `\n`, pero en ConPTY/PSReadLine Enter es `\r` — el comando queda en el editor multilínea sin ejecutar (el scrollback muestra continuation prompts y ghost-text de PSReadLine, que confunde también al observador); (b) el sentinel del adapter es POSIX (`printf`, `"$?"`) e incompatible con pwsh. Requiere: traducción de line-endings por plataforma en el agente + variante pwsh del sentinel en jarvisd. Mientras tanto: misiones locales Windows NO soportadas; usar targets remotos.
- **Race spawn→blocked** reapareció en esa misma configuración (era consecuencia del input fallido, no del guard `spawning`).
- Deudas previas del ADR sin cambios: terminales locales no sobreviven restart del runtime (fail-safe recovery→needs_input), toast nativo con app cerrada (inbox lo retiene), banner "reconectando", hardening JWT del MCP.

## Observaciones menores

- Tras `resume` de una misión gateada por auditoría, el estado reaparece como `blocked` "misión ociosa" (genérico) en vez del `needs_input` específico de auditoría — sin auto-aprobación igual, pero pierde especificidad para el usuario (mejora pendiente en `_ensure_progress`).
- El bloque panel Jarvis apareció sin meta `jarvis:brainurl`/`braintoken` tras los ciclos (mostraba "Cerebro no conectado (127.0.0.1:8770)" aunque el indicador del tab bar sí funcionaba); reconfigurado por `wsh setmeta`. Vigilar si la meta se vuelve a perder.
- El digest §21 "mientras no estabas" quedó verificado solo indirectamente (inbox retiene los ítems; telemetría `jarvis.away_digest` tipada) — no se capturó el toast/panel del digest en pantalla.

## §43 — DoD

| # | Criterio (Detached Runtime) | Estado | Evidencia |
|---|---|---|---|
| 1 | UI lifecycle ≠ execution lifecycle: cerrar/matar la UI no interrumpe ejecución | PASS | E2E-1/2/3/5; sesión Claude orquestadora sobrevivió 2 cierres + 1 taskkill |
| 2 | wavesrv corre detached (task `NexusRuntime`), sobrevive stdin cerrado | PASS | smoke Windows + pid 30692 estable todo el día |
| 3 | App attachea a runtime existente vía runtime.json/authkey, sin respawn | PASS | log 06:15:48 y 06:37:30 "runtime mode: attached" sin spawn |
| 4 | Misiones avanzan y completan con UI cerrada (spawn incluido) | PASS | m-806c30428a, m-6c75d001ce, m-3031726526 creadas/corridas sin UI |
| 5 | needs_input con UI cerrada queda retenido y visible al reabrir | PASS | inbox + tab bar "1 atención" + panel (capturas) |
| 6 | Workers remotos durables sobreviven restart del runtime (ReconnectJob) | EN VALIDACIÓN | E2E-4 disparado; evidencia en `D:\Mcp\e2e4-evidence.txt` + `e2e4-heartbeat.log` sin cortes |
| 7 | Terminales locales: clase no-recuperable documentada con fail-safe | PASS (por diseño) | deuda documentada en JARVIS_UX.md; la sesión orquestadora es el ejemplo vivo |
| 8 | Cierre explícito de UI: aviso una-sola-vez + quit limpio | PASS con fix | bug de hang encontrado/arreglado (`7e1ba283`, ships beta.1); con flag seteado quit ~12s |
| 9 | Update de la app no mata el trabajo (AUTO_UPDATE_DETECTED) | PASS | update beta.2→0.17.0-beta.0 aplicado; runtime nuevo del primer arranque post-update |
| 10 | Regresión completa verde | PASS | vitest 151/151, tsc limpio, go test (rig3060 + local mcp), pytest 1567 |
