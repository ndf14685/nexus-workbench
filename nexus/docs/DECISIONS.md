# Nexus Workbench — Registro de decisiones

> Decisiones mayores en `adr/`. Este archivo registra las menores/operativas.

| # | Fecha | Decisión | Justificación |
|---|---|---|---|
| D-001 | 2026-07-28 | Docs propias en `nexus/docs/`, no en `docs/` | `docs/` es el Docusaurus de Wave (`onBrokenLinks: throw`); archivos ajenos rompen su build y generan conflictos de merge |
| D-002 | 2026-07-28 | Config propia en YAML bajo `nexus/config/`, proyectada a `connections.json`/`presets.json` | pedido explícito de config versionable fuera de SQLite; los JSON de Wave son API pública con watcher en caliente |
| D-003 | 2026-07-28 | Distinción de ambientes vía `term:theme` por conexión + presets `bg@nexus-*` | cero código UI nuevo, cero drift vs upstream; el indicador propio queda para Fase 2 |
| D-004 | 2026-07-28 | `publish.url` → `https://updates.nexus-workbench.invalid/releases` | TLD `.invalid` (RFC 2606) garantiza que el updater empaquetado jamás resuelva el feed de Wave; reversible cuando exista feed propio |
| D-005 | 2026-07-28 | Defaults del fork: `autoupdate:enabled=false`, `telemetry:enabled=false` | evitar updates no gobernados y no contaminar la telemetría de Wave con datos del fork |
| D-006 | 2026-07-28 | Guardas `repository_owner == 'wavetermdev'` en publish-release, bump-version, testdriver* | esos workflows requieren secretos de Command Line Inc y son ruido/riesgo en el fork; guardar > borrar (merge-friendly) |
| D-007 | 2026-07-28 | Identificadores internos (`appId`, `WAVETERM_*`, `~/.waveterm`, binarios) NO se renombran | son el motor (ADR-0001); renombrarlos rompe wsh remoto instalado, data dirs y el handshake WAVESRV-ESTART sin valor de producto |
| D-008 | 2026-07-28 | Fix del baseline: `tsgenevent_test.go` (assert multilínea) y mocks de `frontend/preview/` | rotos en upstream c99022c1; sin el fix no hay CI verde; si upstream los arregla, en el merge gana upstream |
| D-009 | 2026-07-28 | Tags de release del fork: `nexus-v*` (no `v*`) | los tags `v*` disparan `build-helper.yml` de upstream (firma/S3); separación limpia de canales |
| D-010 | 2026-07-28 | Toolchain local en `~/.local/nexus-toolchain/` (Go 1.25.12, Task 3.52) | la máquina no tenía Go/Task; instalación sin sudo, reproducible por bootstrap.sh |
| D-011 | 2026-07-28 | Baseline con 1 fallo de test Go y 12 errores tsc documentados y corregidos | honestidad del baseline: los fallos eran de upstream, no del fork |
| D-012 | 2026-07-28 | Versión de la app se mantiene = upstream (0.14.5) hasta la primera release propia | simplifica el primer sync; el canal nexus-v* independiza el versionado cuando haga falta |
| D-013 | 2026-07-29 | Feed de updates = GitHub Releases del fork (provider `github`); draft=candidate, publicada=stable | reemplaza el placeholder `.invalid` de D-004; electron-updater ignora drafts ⇒ compuerta manual sin infra propia |
| D-014 | 2026-07-29 | Tags de release del fork pasan a `v*` (reemplaza D-009); `build-helper.yml` guardado con repository_owner | el provider github de electron-updater espera tags `v<semver>`; la guarda elimina el riesgo que motivaba nexus-v* |
| D-015 | 2026-07-29 | AI: modos propios en `waveai.json` con keys en el secret store (`wsh secret` + `ai:apitokensecretname`); nunca tokens en config/repo | backends nativos anthropic/openai/gemini/ollama verificados en `pkg/aiusechat`; secret store cifrado vía safeStorage |
| D-016 | 2026-07-29 | Indicador de ambiente en tab bar: setting `nexus:environments` (SettingsType) proyectado por el importador a settings.json; componente propio en `frontend/app/nexus/` con inserción de 2 líneas en tabbar.tsx | cierra el diferido de D-003; el catálogo viaja por el config system nativo (watcher en caliente, tipos generados) y el diff en el árbol de Wave queda mínimo |
| D-017 | 2026-07-29 | verify.sh: check de branding valida `owner: "ndf14685"` y ausencia de `waveterm.dev` en electron-builder.config.cjs (antes exigía el placeholder `.invalid`) | el check había quedado obsoleto tras D-013 y fallaba en verde legítimo |
| D-018 | 2026-07-30 | Workspaces declarativos: RPC `WorkspaceCreateCommand` (wshserver) + `wsh workspace create --json` + `import-workspaces.mjs`; layout plano (fila de bloques), idempotente por nombre | única extensión RPC del fork hasta ahora; el layout plano cubre el catálogo real y el wire format admite enriquecerse; al aplicar layout propio se borran los bloques del new-tab default (ClearTree no toca la block list) |
| D-019 | 2026-07-30 | Las 40 alertas CodeQL iniciales (todas en código upstream) se descartan con justificación por clase; CodeQL sigue activo y las alertas nuevas se triagean una a una (tabla y regla en SECURITY.md) | reescribir el manejo de archivos/exec del motor rompería funcionalidad y violaría el drift mínimo (ADR-0001) sin eliminar riesgo real: app local single-user, RPC autenticado, sin límite de privilegio que cruzar |
