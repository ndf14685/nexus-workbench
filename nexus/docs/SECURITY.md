# Nexus Workbench — Seguridad

## Reglas activas desde el bootstrap

1. **Sin secretos en Git.** La config real (`nexus/config/*.yaml`) está en
   `.gitignore`; solo se versionan `*.example.yaml`. El importador
   (`import-environments.mjs`) **aborta** si detecta patrones de
   password/token/clave privada en el catálogo. `verify.sh` y `nexus-ci.yml`
   corren un scan básico de secretos sobre el árbol versionado.
2. **Autenticación SSH delegada.** El catálogo solo guarda *alias* de
   `~/.ssh/config`. Claves y passphrases las maneja ssh-agent (en Windows:
   servicio `ssh-agent` de OpenSSH + `ssh-add`; Wave usa la infraestructura
   SSH nativa — `pkg/remote/sshagent_*.go`).
3. **Distinción visual de ambientes.** prod=warmyellow, work=campbell,
   lab=dracula, personal=default-dark (term:theme por conexión) + fondos de
   tab `Nexus: <clase>`. Objetivo: nunca confundir una terminal de prod con
   una de lab.
4. **Sin comandos destructivos automáticos.** `commands.yaml` es un catálogo
   pasivo; los marcados `destructive: true` exigen ejecución manual explícita.
   Cuando exista `Bridge.runCommand`, la confirmación será obligatoria para
   `destructive` o class ∈ {prod, work} (contrato en BRIDGE.md).
5. **Telemetría y phone-home apagados por default** en el fork
   (`telemetry:enabled=false`); el ping diagnóstico puede matarse con
   `WAVETERM_NOPING=1`. El autoupdate del canal de Wave está neutralizado.
6. **Superficie de red del motor**: `wavesrv` escucha solo en `127.0.0.1`
   (puertos efímeros) y en un domain socket 0700; el RPC exige auth key
   (`WAVETERM_AUTH_KEY`) y JWT para remotos. (Verificado en
   `cmd/server/main-server.go`, `pkg/web/`, `emain/authkey.ts`.)

## Modelo de amenazas inicial (resumido)

| Amenaza | Postura |
|---|---|
| Secreto commiteado por accidente | gitignore + scan en verify/CI + example files |
| Update malicioso/no deseado del canal de Wave | feed `.invalid` + default off (no puede pisar el fork) |
| Ejecución accidental en prod | temas/fondos por clase; confirmación manual; sin runbooks automáticos |
| Exfiltración por telemetría | default off en el fork |
| Robo de claves SSH | nunca las tocamos: viven en ssh-agent/OS |
| Dependencias vulnerables | `npm audit` en verify (informativo); `govulncheck` en checklist de sync; Dependabot de upstream sigue activo |
| Instalador sin firma (SmartScreen) | riesgo aceptado para uso personal; verificar hash del artifact de CI |

## CodeQL — triage de alertas en código upstream (D-019, 2026-07-30)

`codeql.yml` (heredado de upstream) corre en el fork y mantiene cobertura de
todo el árbol, incluido el código Go propio (`nexus/mcp`, extensiones RPC).

Las 40 alertas iniciales (2 critical, 37 high, 1 medium) estaban **todas en
código upstream de Wave** y se descartaron con justificación individual en
GitHub → Security → Code scanning. Clases y racional:

| Clase (regla) | Cantidad | Resolución | Racional |
|---|---|---|---|
| `go/command-injection` (builder Tsunami) | 2 critical | won't fix | ejecuta el binario que el builder acaba de compilar del código del propio usuario, como el mismo usuario local — equivalente a `go run`; no hay límite de privilegio que cruzar |
| `go/path-injection` (wshremote_file, web, wavebase, waveappstore, fileutil, buildercontroller, tsunami) | 33 high | won't fix | acceder a rutas arbitrarias **es la funcionalidad** de un terminal/administrador de archivos; las rutas las provee el usuario local autenticado (authkey/JWT) y el proceso corre con sus privilegios |
| `go/stack-trace-exposure` (pkg/web) | 1 medium | won't fix | server HTTP local con authkey obligatorio; el único cliente es el propio frontend |
| `go/allocation-size-overflow` (`make(x, len(y)+1)`) | 4 high | false positive | `len()` de slices Go está acotado por la memoria direccionable; `len+1`/`len+count` no puede desbordar int64 |

**Hallazgo real derivado del triage (2026-07-30):** revisando a mano los 40
sitios apareció el bug genuino que CodeQL no reportó como tal: 5 handlers de
`pkg/web/web.go` escribían el error HTTP pero seguían ejecutando por falta de
`return` (el peor: `handleService` ejecutaba el service call con datos vacíos
tras rechazar el body por inválido). Corregido en el fork y aportado a
upstream: https://github.com/wavetermdev/waveterm/pull/3455.

**Regla operativa:** las alertas nuevas de CodeQL NO se descartan en bloque.
Toda alerta en código propio (`nexus/`, extensiones en el árbol de Wave) se
arregla o se justifica individualmente aquí. Las de código upstream se evalúan
contra este modelo de amenaza; si upstream las arregla, el fix entra por sync.

## Paneles web de IA (D-031)

Un chat web embebido es contenido remoto corriendo dentro de la app: se trata
como hostil por defecto.

- **Sin puente al sistema.** `will-attach-webview` fuerza en CUALQUIER
  `<webview>` `nodeIntegration:false`, `nodeIntegrationInSubFrames:false`,
  `contextIsolation:true`, `webSecurity:true`, `allowRunningInsecureContent:false`.
  No hay acceso a filesystem, terminal, SSH ni a las RPC internas: la única
  superficie que un panel comparte con la app es el `preload-webview` histórico
  (menú contextual de imagen y navegación con los botones laterales del mouse).
- **Permisos mínimos** (`frontend/app/nexus/ai-web-policy.ts`, aplicados en
  `emain/emain-aiweb.ts`): se conceden portapapeles sanitizado de ESCRITURA,
  pantalla completa, storage-access y micrófono. Se niegan geolocalización,
  notificaciones, cámara, captura de pantalla, USB/serial/HID, lectura del
  portapapeles, detección de inactividad y midi. Dispositivos físicos: negados
  en bloque (`setDevicePermissionHandler`).
- **Certificados**: `setCertificateVerifyProc` delega siempre en Chromium
  (`callback(-3)`); el handler existe solo para dejar registro del rechazo. Un
  certificado inválido nunca se acepta en silencio.
- **Ventanas y links**: un `window.open` reconocido como login abre una ventana
  emergente propia (misma partición, `sandbox:true`, sin preload, solo `http(s)`);
  el resto de los links va al navegador del sistema; los esquemas que no son web
  no se abren en ningún lado.
- **Credenciales**: no se guardan ni se inyectan. La sesión vive donde la pone
  Chromium (partición `persist:ai-<proveedor>`, data dir de la app), aislada por
  proveedor.

## SBOM / dependencias

- `npm audit --omit=dev` corre en `verify.sh` (informativo, no bloquea).
- SBOM: backlog — `npx @cyclonedx/cyclonedx-npm` + `go mod download -json`
  pueden generarlo sin tocar el build; no bloquea el MVP.

## Pendientes de seguridad (backlog priorizado)

1. `govulncheck` integrado a verify.sh cuando el toolchain lo tenga.
2. SBOM CycloneDX en CI.
3. Confirmación UI para conexiones class=prod (post-MVP, vía Bridge).
4. Revisión del contenido de `aiprompts/` y endpoints de Wave AI si se usan.
