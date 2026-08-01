# Nexus Workbench — Sincronización con upstream

> Modelo completo y racional en [ADR-0003](adr/ADR-0003-upstream-synchronization.md).

## Topología

- `origin` = fork (`ndf14685/waveterm`, a renombrar `nexus-workbench`)
- `upstream` = `https://github.com/wavetermdev/waveterm.git` (solo fetch)
- Ramas: `main` (estable) ← `release/*` ← `develop` ← `feature/*` y
  `upstream-sync/<tag>`
- Baseline actual: tag **`wave-baseline/v0.14.5-32-gc99022c1`**

## Detección

- Automática: workflow `nexus-upstream-watch.yml` (lunes 09:00 UTC) abre un
  issue `upstream-sync` cuando hay release estable nueva.
- Manual: `nexus/scripts/upstream-check.sh`

## Procedimiento por release

```bash
nexus/scripts/upstream-check.sh --start vX.Y.Z   # crea upstream-sync/vX.Y.Z desde develop
git merge vX.Y.Z                                  # integrar el tag
# ...resolver conflictos...
npm install                                       # deps pueden haber cambiado
nexus/scripts/verify.sh                           # build + tests + seguridad + branding
```

Checklist adicional del informe (usar
`nexus/docs/templates/upstream-sync-report.md`, guardar en `nexus/reports/`):

1. ¿Migraciones nuevas en `db/migrations-wstore/` o `db/migrations-filestore/`?
2. ¿Cambios en `pkg/wconfig` (claves nuevas, defaults, formato)?
3. ¿Cambió `emain/updater.ts`, `electron-builder.config.cjs` (publish!),
   `pkg/wconfig/defaultconfig/settings.json` (nuestros defaults!) o
   `.github/workflows/` (nuestras guardas!)? → re-aplicar decisiones del fork.
4. `npm audit` / `govulncheck ./...` — vulnerabilidades nuevas.
5. Probar en dev: terminal local, una conexión SSH, un preview remoto.
6. Merge a `develop`; usar unos días; aprobar a `main` manualmente.
7. Actualizar baseline: `git tag -f wave-baseline/vX.Y.Z vX.Y.Z` y
   actualizar este archivo.

## Zonas calientes de conflicto (nuestro diff vive ahí)

| Archivo | Nuestro cambio |
|---|---|
| `package.json` | productName/description |
| `electron-builder.config.cjs` | publish.url, artifactName |
| `pkg/wconfig/defaultconfig/settings.json` | autoupdate/telemetry off |
| `emain/emain-platform.ts`, `emain/emain.ts`, `emain/emain-menu.ts`, `emain/updater.ts` | strings visibles |
| `frontend/wave.ts`, `index.html`, `frontend/app/modals/about.tsx`, `frontend/app/onboarding/onboarding.tsx` | strings visibles |
| `.github/workflows/{publish-release,bump-version,testdriver*,}.yml` | guardas repository_owner |
| `frontend/preview/**`, `pkg/tsgen/tsgenevent_test.go` | fixes de baseline (pueden llegar arreglados de upstream: quedarse con upstream) |

Todo lo demás propio está en `nexus/` y `.github/workflows/nexus-*.yml`
(sin equivalente upstream ⇒ merge limpio).

## Canales y "Check for Updates"

El updater de la app (electron-updater) apunta a **las GitHub Releases de
`ndf14685/nexus-workbench`** (provider `github` en `electron-builder.config.cjs`),
nunca a los servers de Wave. electron-updater **ignora releases en borrador**,
lo que da la compuerta manual:

| Canal | Qué es | Cómo se produce |
|---|---|---|
| dev | `task dev` local | siempre disponible |
| beta | prerelease **publicada automáticamente** con instalador + `beta.yml` | push de tag `v*-beta.N` → `nexus-windows-package.yml` (D-026) |
| candidate | draft release con instalador + `beta.yml` | push de tag `vX.Y.Z` → `nexus-windows-package.yml` |
| stable | la draft release **publicada a mano** | recién ahí "Check for Updates" la ofrece como stable |

La app viene con `autoupdate:enabled=true` y canal `beta` (D-026): busca sola,
descarga sola y ofrece instalar. El canal `beta` de electron-updater acepta
tanto prereleases como stables publicadas, así que una stable publicada a mano
también llega sin tocar nada. El channel file se llama `beta.yml` (no
`latest.yml`) porque `publish.channel` del builder es `beta`.

Flujo de release propio:

```bash
task version -- patch        # bumpea package.json (p.ej. 0.15.0-beta.7)
git commit -am "release: v0.15.0-beta.7" && git push
git tag v0.15.0-beta.7 && git push origin v0.15.0-beta.7   # CI: build + prerelease PUBLICADA
# tag sin -beta. (vX.Y.Z) → draft: probar el instalador → GitHub → Releases → publicar = stable
```

Novedades de Wave siempre entran por `upstream-sync/<tag>` → filtro/merge →
release propia; el usuario final solo ve lo que publicamos nosotros.
(`build-helper.yml` de upstream quedó guardado con `repository_owner`, así que
nuestros tags `v*` no lo disparan.)
