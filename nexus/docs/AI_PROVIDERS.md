# Nexus Workbench — AI Providers (capa neutral)

> **Principio (D-021):** WaveTerm aporta el motor de escritorio, terminales y
> sesiones. **Wave AI no define la arquitectura de inteligencia de Nexus
> Workbench** — es, como mucho, un proveedor opcional apagado por default.

## Estado de Wave AI en el fork

| Componente | Estado | Mecanismo |
|---|---|---|
| Botón "Wave AI" en tab bar (top y left) | oculto | `app:hideaibutton=true` default del fork (upstream ya lo soporta) |
| Panel lateral Wave AI | **desmontado** (no solo invisible) | `workspace.tsx` no monta `<AIPanel/>` con AI oculta — su mount llamaba `ensureRateLimitSet()` contra el cloud de Wave |
| Restauración del panel abierto de sesiones previas | bloqueada con AI oculta | gate en `workspace-layout-model.ts` `initializeFromMeta()` |
| Atajo `Cmd:Shift:A` | no abre el panel con AI oculta (solo puede cerrarlo) | gate en `keymodel.ts` |
| Widget default de AI en barra derecha | no existe en defaults | verificado `defaultconfig/widgets.json` |
| Onboarding/prompts de API keys | no ocurren | no hay modales AI en el arranque; los modos propios (D-015) usan el secret store, nunca prompts |
| Telemetría/updates de Wave | apagados | D-005 / D-013 |

**Consecuencia verificada:** la app inicia sin ningún panel de AI, no pide API
keys y no hace conexiones cloud de AI. Terminales, SSH, ambientes, workspaces y
la sidebar funcionan sin ningún proveedor configurado.

**Re-habilitar Wave AI como proveedor opcional** (reversible, sin rebuild):
`wsh setconfig app:hideaibutton=false` — vuelven botón, panel y atajo, con los
modos de `waveai.json` (incluidos los propios de D-015 con keys en secret store).

## Interfaz neutral (contrato objetivo)

El Workbench Core habla con proveedores a través de esta interfaz — nunca
directamente con la implementación interna de Wave AI:

```ts
interface NexusAIProvider {
    listProviders(): ProviderInfo[];            // catálogo + estado de sesión
    getProviderStatus(id: string): ProviderStatus; // available | needs-auth | offline
    openConversation(id: string, ctx?: EnvRef): Promise<SessionRef>;
    sendPrompt(session: SessionRef, prompt: string): Promise<void>;
    streamResponse(session: SessionRef): AsyncIterable<Chunk>;
    attachTerminalContext(session: SessionRef, blockId: string): Promise<void>;
    cancelExecution(session: SessionRef): Promise<void>;
}
```

## Adaptadores

| Proveedor | Estado | Adaptador |
|---|---|---|
| Claude (Claude Code CLI, sesión OAuth propia) | **funcionando hoy** | CLI-en-bloque (v0, abajo) |
| ChatGPT/Codex (CLI, sesión OAuth propia) | **funcionando hoy** | CLI-en-bloque (v0) |
| Gemini (gemini CLI) | listo para usar | agregar entrada `agents` al catálogo |
| Ollama / modelos locales | listo para usar | entrada `agents` (`ollama run <modelo>`), o modo waveai `ai:provider=ollama` (D-015) si se rehabilita el panel |
| Nexus AI Provider Fabric | pendiente | adaptador futuro contra la API v1 del idp (no acoplar a Wave AI) |
| Wave AI (cloud de Wave) | opcional, apagado | `app:hideaibutton=false` |

### Adaptador v0 (real, no simulado): CLI-en-bloque

La sección `agents` de `nexus/config/environments.json` **es** el registro de
proveedores v0. Cada entrada lanza un CLI de IA con sesión propia (OAuth del
CLI, sin API keys en el Workbench) en un bloque terminal visible, local o en un
ambiente remoto (`environment: <id>`). El importador los proyecta como widgets
(`nexus-agent-*`) — esa es la ubicación discreta de "AI Providers" en la UI.

**Un proveedor = un botón (D-028).** Las variantes de invocación de la misma
herramienta (normal vs. permisos totales) NO son proveedores distintos: se
declaran como `modes` del mismo agente y el click abre un menú para elegir
(las peligrosas marcadas con `⚠ `). Ver el esquema en [AI.md](AI.md). Además el
importador descarta entradas de `commands` que dupliquen un agente (mismo id o
mismo comando), así que el catálogo no puede generar dos botones para el mismo
CLI.

Mapeo honesto del contrato sobre el adaptador v0: `listProviders` = sección
`agents` del catálogo; `openConversation` = click en el widget (createBlock);
`attachTerminalContext`/`streamResponse` programáticos = los provee el MCP del
Workbench (`get_terminal_output`, `run_command`) — ver [MCP.md](MCP.md).
`getProviderStatus`/`cancelExecution` quedan pendientes para el adaptador v1.

### Qué falta desacoplar (backlog)

- Selector de proveedor activo en UI (hoy: un widget por proveedor, con menú
  de modos por widget — D-028).
- Adaptador v1 con `getProviderStatus` (detectar CLI instalado/logueado) y
  `cancelExecution`.
- Fabric adapter (API v1 del idp).
- Si algún día se quiere chat embebido no-Wave: implementar `NexusAIProvider`
  sobre un panel propio, NUNCA extendiendo `aipanel/` de upstream.
