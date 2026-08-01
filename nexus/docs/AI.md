# Nexus Workbench — IA con suscripciones propias

## Suscripciones OAuth (Claude Pro/Max, Codex) — la vía principal

El panel "Wave AI" **no** soporta OAuth de suscripciones (sus backends
autentican por token). La forma soportada de usar las suscripciones es correr
los **CLIs oficiales dentro de la app**: `claude` (Claude Code) y `codex`
hacen su propio login OAuth con la suscripción.

El importador genera **un** botón "Claude Code" y **un** botón "Codex" en la
barra lateral (sección `agents:` del catálogo `environments.yaml`/`.json`): un
click lanza el CLI en un bloque terminal, local o en un ambiente remoto (campo
`environment`). Con el MCP (`nexus/docs/MCP.md`) registrado en esos CLIs
(`claude mcp add nexus-workbench -- <exe> --environments <catálogo>`), el
agente con tu suscripción **controla la app**: ambientes, terminales,
archivos, con la gobernanza ADR-0004.

### `modes:` — una herramienta, un botón (D-028)

Una misma herramienta suele tener varias formas de invocarse (normal vs.
permisos totales). Declararlas como agentes o comandos separados producía un
botón por variante. En vez de eso, se declaran como **modos del mismo agente**:
con 2 o más modos el click abre un menú para elegir, en lugar de crear el
bloque directamente.

Campos de cada modo: `id` (opcional, solo referencia), `label` (texto del
menú; default = `id` o el comando), `command` (obligatorio) y `danger: true`
(opcional) para marcar la variante peligrosa. Los menús nativos de Electron no
admiten color por item, así que un modo `danger` se muestra con el prefijo
**`⚠ `** — es la única marca honesta disponible en esa superficie.

```yaml
agents:
    - id: claude
      name: Claude Code
      command: claude # comando por defecto (si se omite, gana el primer modo)
      icon: robot
      modes:
          - id: normal
            label: Claude Code
            command: claude
          - id: full
            label: Claude Code (permisos totales)
            command: claude --dangerously-skip-permissions
            danger: true

    - id: codex
      name: Codex
      command: codex
      icon: microchip
      modes:
          - id: normal
            label: Codex
            command: codex
          - id: full
            label: Codex (permisos totales)
            command: codex --yolo
            danger: true
```

El importador proyecta eso a **un** widget `nexus-agent-<id>` cuyo
`blockdef.meta` lleva `"nexus:modes"`. El `cmd` base sigue siendo el comando
por defecto, así que cualquier consumidor que ignore los modos funciona igual.
Sin `modes` (o con uno solo) el comportamiento es el de siempre: click = abrir
el bloque.

**Deduplicación automática:** si una entrada de `commands.yaml`/`.json`
colisiona con un agente —mismo `id`, o mismo `command` aunque el id difiera—
el importador **no** genera el widget `nexus-cmd-*` y avisa nombrando ambas
entradas. Así el catálogo no puede volver a producir dos botones para la misma
herramienta.

### El catálogo vive en la app (D-031)

Desde D-031 los accesos de IA **no dependen** de que el importador haya corrido:
el catálogo único está en `frontend/app/nexus/ai-apps.ts` y la barra lo fusiona
con `widgets.json`. Desde D-032 son **tres botones, uno por proveedor**, y el
click ofrece las superficies de ese proveedor:

| Botón | Al hacer click | Qué abre |
|---|---|---|
| **ChatGPT** | ChatGPT (panel web) | bloque `web` en `persist:ai-chatgpt` |
| | Codex CLI — Normal | bloque `term` corriendo `codex` |
| | ⚠ Codex CLI — Permisos totales | bloque `term` corriendo `codex --yolo` |
| **Claude** | Claude Chat (panel web) | bloque `web` en `persist:ai-claude` |
| | Claude CLI — Normal | bloque `term` corriendo `claude` |
| | ⚠ Claude CLI — Permisos totales | bloque `term` corriendo `claude --dangerously-skip-permissions` |
| **Gemini** | Gemini (panel web) | bloque `web` en `persist:ai-gemini` |
| | Agy CLI — Normal | bloque `term` corriendo `agy` |
| | ⚠ Agy CLI — Permisos totales | bloque `term` corriendo `agy --dangerously-skip-permissions` |

Un proveedor con una sola superficie no mostraría menú (el click abriría el
bloque directo), pero hoy los tres tienen chat + CLI, así que los tres abren el
desplegable.

Antigravity **no** es un botón aparte: es el IDE agéntico de Google (el lado de
código de Gemini) y no tiene chat web. Su CLI —`agy`— es el agente de terminal
del botón Gemini, y el chat es `gemini.google.com/app`.

**Plegado automático.** Si `widgets.json` trae widgets locales que lanzan
`claude`, `codex` o `agy` —incluso envueltos en `wsl -d Ubuntu --`, `bash -lc "..."`,
`cmd /c` o variables de entorno— la barra los **funde** dentro del botón del
proveedor; las invocaciones que no estén en el catálogo se conservan como acción
extra del mismo menú. Lo mismo con un widget web que apunte al mismo origen que
un chat del catálogo (típicamente un `nexus-link-*`). Un widget con `connection`
NO se pliega: un agente en un ambiente remoto es otra herramienta, no una
variante de la local. El importador hace el mismo plegado en el origen, sobre la
sección `agents:`.

**Personalizar sin recompilar.** Cada built-in tiene una clave estable
(`nexus-ai-<proveedor>`: `nexus-ai-openai`, `nexus-ai-anthropic`,
`nexus-ai-google`) y un widget del usuario con esa misma
clave **gana**. Para cambiar la URL de un chat, ocultar un acceso o agregar otro
proveedor, menú contextual de la barra → *Edit widgets.json*:

```json
{
    "nexus-ai-google": {
        "icon": "gem",
        "label": "Gemini",
        "blockdef": {
            "meta": { "view": "web", "url": "https://LA-URL/", "web:partition": "persist:ai-gemini" }
        }
    },
    "nexus-ai-perplexity": {
        "icon": "comments",
        "label": "Perplexity",
        "blockdef": {
            "meta": { "view": "web", "url": "https://www.perplexity.ai/", "web:partition": "persist:ai-perplexity" }
        }
    }
}
```

Para esconder un acceso built-in alcanza con redefinir su clave con
`"display:hidden": true`.

## Chats web: sesión, permisos y login

Los chats web son bloques `web` normales — el mismo componente, el mismo layout,
el mismo desacople a otra pantalla y la misma persistencia de workspace que
cualquier otro módulo. Se pueden abrir varias instancias del mismo proveedor: son
bloques distintos que **comparten la sesión**.

**Persistencia.** Cada proveedor tiene su partición `persist:ai-<id>`. El prefijo
`persist:` es el mecanismo de Chromium/Electron que escribe cookies,
localStorage e IndexedDB en el data dir de la app: el login sobrevive al cierre y
reapertura. No se guarda ni se inyecta ninguna credencial en la config.

**Aislamiento.** `emain/emain-aiweb.ts` aplica sobre esas sesiones la política de
`frontend/app/nexus/ai-web-policy.ts`, y `will-attach-webview` fuerza
`nodeIntegration:false` / `contextIsolation:true` / `webSecurity:true` en
CUALQUIER `<webview>`, sin importar cómo esté escrito el tag. Permisos
concedidos: escritura sanitizada de portapapeles, pantalla completa, acceso a
almacenamiento (logins federados) y **micrófono** (dictado). Todo lo demás se
niega: geolocalización, notificaciones, cámara, captura de pantalla,
USB/serial/HID, lectura del portapapeles, detección de inactividad. Los
certificados los valida Chromium: uno inválido no se acepta en silencio.

**Login y ventanas emergentes.** Un `window.open` de un panel de IA que la
política reconoce como login (disposición `new-window`, o URL de un IdP conocido
o un flujo OAuth con sus parámetros) se abre como **ventana emergente dentro de
la app**, en la misma partición y con los mismos webPreferences endurecidos: la
sesión resultante queda donde el panel la va a leer, y la relación con el
`opener` se conserva (la crea Electron, no la fabricamos nosotros), que es lo que
necesitan los flujos que hacen `postMessage` al abridor. Un link común del chat
sigue yendo al navegador del sistema, y un esquema que no sea `http(s)` no se
abre en ningún lado.

**Limitaciones conocidas de la autenticación embebida:**

- Los paneles de IA se presentan con el user-agent de Chrome de la propia app
  (se le quitan los tokens `waveterm/` y `Electron/`, y nada más): sin eso el
  login con Google contesta "este navegador no es seguro". Es una omisión del
  envoltorio, no un user-agent falso — plataforma y versión de Chrome son las
  reales. Si aun así un IdP rechaza el panel, queda el camino de loguearse en
  el navegador externo.
- **Passkeys / WebAuthn**: el `<webview>` de Electron no expone el autenticador
  de plataforma del SO. Un proveedor que EXIJA passkey no va a poder completar el
  login embebido; los que ofrecen contraseña o código sí.
- **Una sola cuenta de Google por partición.** Loguearse en `persist:ai-gemini`
  NO comparte esa sesión con ChatGPT o Claude: cada partición es un perfil
  separado, y eso es a propósito (una cookie de un proveedor no viaja al otro).
  Si querés "iniciar sesión con Google" en ChatGPT, ese login se hace dentro de
  la partición de ChatGPT y queda ahí.
- **El navegador embebido es el Chromium de Electron**, no tu Chrome instalado:
  no comparte tu perfil de Google ni se actualiza con Chrome. Se actualiza
  cuando actualizás la app (Electron 41.1 ⇒ Chromium 146). No hay forma
  soportada de embeber Chrome del sistema dentro de la app: si querés tu Chrome
  real con tu sesión, el botón "Open in External Browser" del bloque lo abre
  afuera.

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
