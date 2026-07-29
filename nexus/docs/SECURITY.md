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

## SBOM / dependencias

- `npm audit --omit=dev` corre en `verify.sh` (informativo, no bloquea).
- SBOM: backlog — `npx @cyclonedx/cyclonedx-npm` + `go mod download -json`
  pueden generarlo sin tocar el build; no bloquea el MVP.

## Pendientes de seguridad (backlog priorizado)

1. `govulncheck` integrado a verify.sh cuando el toolchain lo tenga.
2. SBOM CycloneDX en CI.
3. Confirmación UI para conexiones class=prod (post-MVP, vía Bridge).
4. Revisión del contenido de `aiprompts/` y endpoints de Wave AI si se usan.
