# ADR-0003: Estrategia de sincronización con upstream WaveTerm

- Estado: Aceptada
- Fecha: 2026-07-28

## Contexto

El fork debe recibir mejoras y fixes de WaveTerm sin que una release de Wave
pueda romper o pisar la versión estable de Nexus Workbench. Upstream publica
tags `vX.Y.Z` (y `-beta.N`); su CI publica instaladores y archivos de
autoupdate (`latest.yml`) a `https://dl.waveterm.dev/releases-w2`.

## Decisión

### Remotos y ramas

- `origin` = fork (github.com/ndf14685/waveterm → a renombrar nexus-workbench).
- `upstream` = github.com/wavetermdev/waveterm (solo fetch, nunca push).
- `main` = estable de Nexus Workbench.
- `develop` = integración habitual.
- `upstream-sync/<tag>` = rama efímera para integrar una release de Wave.
- `release/<version>` = candidatos.
- `feature/*` = cambios propios.
- Tag `wave-baseline/<describe>` marca el commit exacto de Wave usado como base.

**Sin submódulos**: el árbol de Wave vive directamente en el repo; el merge de
Git es la herramienta de integración.

### Proceso de sincronización (manual con soporte de scripts)

1. `nexus/scripts/upstream-check.sh` detecta tags nuevos de upstream.
2. `git checkout -b upstream-sync/<tag> develop && git merge <tag>`.
3. Resolver conflictos (el diff propio dentro del árbol de Wave es mínimo por
   diseño: ver ADR-0001; los puntos calientes están listados en
   `UPSTREAM_SYNC.md` § Zonas de conflicto).
4. `nexus/scripts/verify.sh`: build frontend + wavesrv + wsh, `go test ./...`,
   `vitest run`, `tsc --noEmit`, chequeo de secretos y de branding.
5. Revisar migraciones: `db/migrations-*` y cambios de `pkg/wconfig`.
6. `npm audit` + `govulncheck` si está disponible.
7. Completar `nexus/docs/templates/upstream-sync-report.md`.
8. Merge a `develop`; soak; luego PR/merge manual a `main`.

**Ninguna release de upstream se promueve automáticamente a `main`.**

### Neutralización del canal de autoupdate de Wave

- `publish.url` en `electron-builder.config.cjs` se cambia a un placeholder
  propio (no existe todavía servidor de releases de Nexus): el updater
  empaquetado ya no puede descargar builds de Wave.
- El default de `autoupdate:enabled` queda en `false` para el fork.
- `publish-release.yml` y `bump-version.yml` de upstream se desactivan en el
  fork (requieren secretos de Command Line Inc y son peligrosos si se disparan).

### Canales propios

- `dev`: build local (`task dev` / `task package` sin firma).
- `candidate`: artefactos de CI (workflow manual) sobre `release/*`.
- `stable`: artefacto aprobado manualmente, taggeado en `main`.

## Consecuencias

- (+) Reproducible, auditable, sin sorpresas de upstream.
- (+) El informe por sync deja rastro de decisiones y riesgos.
- (−) La sincronización es semi-manual (aceptado: frecuencia ~mensual).
