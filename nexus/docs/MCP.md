# Nexus Workbench — Servidor MCP (control por agentes / Jarvis)

`nexus/mcp/` implementa el **Workbench Bridge** (ADR-0002) como servidor MCP
por stdio: un agente (Jarvis, Claude, OpenClaw/Codex) controla la app Nexus
Workbench en ejecución a través de una puerta única, con gobernanza ADR-0004
y auditoría. Binario: `nexus-workbench-mcp(.exe)` — se compila con
`nexus/scripts/build-mcp.sh` y viene incluido en los artifacts de release.

## Cómo funciona (verificado contra el código del motor)

- La app persiste su keypair Ed25519 de JWT en SQLite (`db_mainserver` en
  `<datadir>/db/waveterm.db`). El MCP server (corriendo como el mismo usuario
  del SO) la lee **en modo read-only**, acuña JWTs efímeros (TTL 10 min) con
  los claims de `pkg/wavejwt`, y ejecuta subcomandos `wsh` autenticados contra
  el domain socket `wave.sock`. Cero cambios en el árbol del motor.
- El contexto `conn` del JWT hace que los bloques nuevos hereden la conexión
  del ambiente elegido (ssh/wsl) — así `run_command`/`open_terminal` operan
  sobre el ambiente correcto.
- Requiere: app abierta al menos una vez (DB existente) y corriendo (socket).

## Herramientas expuestas

| Tool | Descripción |
|---|---|
| `list_environments` | catálogo con clase de riesgo por ambiente |
| `run_command` | ejecuta en un bloque terminal NUEVO y VISIBLE; devuelve block id |
| `open_terminal` | terminal interactiva en el ambiente indicado |
| `open_file` | abre archivo/directorio en preview (Monaco) del ambiente |
| `get_terminal_output` | scrollback del bloque (fallback: blockfile `term` del filestore) |
| `list_blocks` | bloques abiertos (JSON: id, tab, vista, conexión) |
| `notify_user` | notificación de escritorio vía la app |
| `get_status` | diagnóstico del puente (datadir, socket, wsh, RPC) |

## Gobernanza (ADR-0004)

- Ambientes `class: prod|work` o `criticality: high`, y cualquier comando que
  matchee los patrones destructivos (rm -rf, mkfs/dd, shutdown/reboot,
  systemctl stop/restart, kubectl delete, docker rm/prune, git push --force,
  DROP/TRUNCATE, etc.) → **confirmación en dos fases**: la primera llamada
  devuelve un `confirm_token` (TTL 2 min) y la instrucción de mostrarle al
  usuario la acción exacta; solo la re-llamada con el token ejecuta.
- El token está ligado al fingerprint exacto (tool + ambiente + comando):
  no se puede reusar para otra acción.
- **Auditoría** append-only en `<datadir>/nexus-mcp-audit.jsonl`
  (ts, tool, env, detalle, decisión).
- Todo lo que el agente ejecuta ocurre en **bloques visibles** de la app:
  el usuario ve cada comando en pantalla.

## Configuración en Jarvis / Claude / OpenClaw

```json
{
    "mcpServers": {
        "nexus-workbench": {
            "command": "C:\\Users\\ndf\\bin\\nexus-workbench-mcp.exe",
            "args": [
                "--environments", "C:\\Users\\ndf\\nexus\\environments.yaml"
            ]
        }
    }
}
```

Flags: `--environments` (obligatorio; o env `NEXUS_ENVIRONMENTS_FILE`),
`--wsh` (autodetecta el binario de la app instalada; o `NEXUS_WSH_PATH`),
`--data-dir`, `--dev` (usa `waveterm-dev`), `--workspace <nombre>` (tab
destino; default: primer workspace activo), `--audit <ruta>`.

## Validación realizada (2026-07-29, Linux headless)

- E2E real contra `wavesrv` 0.14.5: initialize/tools/list ✅, `get_status`
  con RPC OK ✅, `list_environments` ✅, `run_command` local creó y ejecutó el
  bloque ✅, confirmación de destructivo y de class=work con token ✅,
  `list_blocks` JSON ✅, auditoría escrita ✅.
- `get_terminal_output` requiere la app con UI (el scrollback lo sirve el
  renderer; el fallback de filestore necesita que el controller del bloque
  haya arrancado, cosa que dispara la vista). Pendiente de validar en Windows
  con la app abierta — el resto del puente ya quedó probado.

## Límites conocidos / backlog

- El tab destino es el activo del workspace (no hay selección de tab por tool).
- `create_workspace`/`restore_workspace` del contrato Bridge: backlog.
- La clave JWT da control total local: proteger el acceso a la cuenta de
  usuario del SO es la frontera de seguridad real (igual que con la app misma).


## jarvis-agent (subcomando headless)

El mismo binario corre como agente del Mission Supervisor:

```
nexus-workbench-mcp.exe jarvis-agent --brain http://<cerebro>:8770 --wsh <wsh.exe> --environments <environments.json|yaml>
```

- Se registra como cliente `workbench` (`wb-<hostname>`) vía
  `POST /clients/register` y ejecuta por SSE las capabilities
  `env.list` / `terminal.list|create|input|read|set_meta|close` usando `wsh`
  con JWT minteado de `waveterm.db` (igual que el server MCP).
- **Gobernanza (ADR-0004 §2)**: `terminal.input` con patrón destructivo sobre
  un ambiente `class=prod` se deniega en el Workbench (el cerebro además tiene
  su InstructionGuard); toda capability de escritura queda en
  `nexus-mcp-audit.jsonl` con decisión (`allowed` /
  `allowed_destructive_nonprod` / `denied_destructive_prod`).
- Reconexión SSE con backoff 1s-30s y re-registro; la primera conexión va
  live-only (sin `?since=`) para no re-ejecutar invokes de una vida anterior.
- En Windows corre como Scheduled Task `JarvisAgent` (logon + restart on
  failure); token por env `NEXUS_BRAIN_TOKEN`.

Tools MCP agregadas después de la tabla original: `check_approval`,
`list_runbooks`, `run_runbook`, `list_agents`, `launch_agent`, `notify_user`,
`get_status`.

