# Nexus Workbench — IA con suscripciones propias

## Suscripciones OAuth (Claude Pro/Max, Codex) — la vía principal

El panel "Wave AI" **no** soporta OAuth de suscripciones (sus backends
autentican por token). La forma soportada de usar las suscripciones es correr
los **CLIs oficiales dentro de la app**: `claude` (Claude Code) y `codex`
hacen su propio login OAuth con la suscripción.

El importador genera botones "Claude Code" y "Codex" en la barra lateral
(sección `agents:` del catálogo `environments.yaml`/`.json`): un click lanza
el CLI en un bloque terminal, local o en un ambiente remoto (campo
`environment`). Con el MCP (`nexus/docs/MCP.md`) registrado en esos CLIs
(`claude mcp add nexus-workbench -- <exe> --environments <catálogo>`), el
agente con tu suscripción **controla la app**: ambientes, terminales,
archivos, con la gobernanza ADR-0004.

## Panel Wave AI con proveedores propios (requiere API key u Ollama)

> Verificado en el código del baseline: `pkg/aiusechat/` tiene backends nativos
> `anthropic-messages`, `openai-responses`, `openai-chat` y `google-gemini`
> (`usechat-backend.go`), y las API keys pueden resolverse desde el **almacén
> cifrado de secretos** de Wave (`pkg/secretstore`, archivo `secrets.enc` en la
> data dir, cifrado vía safeStorage de Electron) usando `ai:apitokensecretname`.

## Por qué

El modo por defecto "wave" enruta por la nube de Wave
(`cfapi.waveterm.dev/api/waveai`). Para independencia y privacidad, los modos
propios llaman **directo** al proveedor con tu API key, o a un modelo local.

## Regla de seguridad

**Nunca** poner la key en `waveai.json` (`ai:apitoken`) ni en nada versionado.
Usar el secret store:

```bash
wsh secret set ANTHROPIC_KEY    # pide el valor, lo guarda cifrado
wsh secret set OPENAI_KEY
```

y referenciarla con `ai:apitokensecretname`.

## Configuración

Los modos AI viven en `<configdir>/waveai.json` (p. ej.
`~/.config/waveterm/waveai.json`). Ejemplo completo en
`nexus/config/waveai.example.json`; copiar los bloques que uses. Resumen:

| Uso | ai:provider | ai:apitype | ai:endpoint |
|---|---|---|---|
| Anthropic (API key propia) | `custom` | `anthropic-messages` | default de Anthropic |
| OpenAI (API key propia) | `openai` | `openai-responses` | default |
| Ollama local (sin key, gratis) | `custom` | `openai-chat` | `http://127.0.0.1:11434/v1` |
| Cualquier endpoint OpenAI-compatible (Groq, OpenRouter, etc.) | provider propio o `custom` | `openai-chat` | el del proveedor |

Los modos aparecen en el dropdown del panel Wave AI junto a los de Wave
(o en lugar de ellos, si se ocultan con `display:order`/borrando defaults).

## Importante sobre "suscripciones"

Las suscripciones de chat (Claude Pro, ChatGPT Plus) **no** son utilizables
desde una app externa — no exponen API. Lo que sí sirve:

- **API keys** (Anthropic Console / OpenAI Platform): pago por uso, es el
  camino soportado por los backends de Wave.
- **Ollama local** (ya presente en tu infra): gratis, privado, sin key.
- Suscripciones con API incluida (p. ej. algunos planes de OpenRouter).

## Apagar Wave AI por completo (opcional)

`settings.json`: `"ai:*": true` como clear + no definir modos, o simplemente
no usar el panel. El endpoint de Wave solo se contacta si se usa un modo
`ai:provider: "wave"`.
