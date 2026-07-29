# Informe de sync upstream — WaveTerm <TAG>

- Fecha:
- Rama: `upstream-sync/<TAG>`
- Baseline anterior: `wave-baseline/<...>`
- Ejecutor:

## Merge

- Conflictos: (archivos y resolución; comparar con zonas calientes de UPSTREAM_SYNC.md)
- Decisiones del fork re-aplicadas: [ ] publish.url [ ] defaults settings.json [ ] guardas workflows [ ] branding strings

## Verificación (`nexus/scripts/verify.sh`)

| Check | Resultado |
|---|---|
| go vet | |
| go test | |
| tsc --noEmit | |
| vitest | |
| build frontend | |
| secretos | |
| branding | |

## Migraciones y config

- Migraciones DB nuevas (`db/migrations-*`):
- Cambios en `pkg/wconfig` (claves/defaults):
- Cambios en updater/electron-builder/workflows:

## Dependencias

- `npm audit`:
- `govulncheck`:

## Prueba funcional (dev)

- Terminal local: [ ]  SSH: [ ]  Preview remoto: [ ]  Layout persiste: [ ]

## Veredicto

- [ ] Merge a `develop`
- [ ] Aprobado a `main` (fecha, por quién)
- [ ] `git tag -f wave-baseline/<TAG> <TAG>` + actualizar UPSTREAM_SYNC.md
