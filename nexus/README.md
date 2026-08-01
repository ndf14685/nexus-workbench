# nexus/ — Nexus Workbench sobre WaveTerm

Todo lo propio del fork vive acá (el resto del árbol es el motor WaveTerm,
con diff mínimo). Empezar por:

- [docs/PRODUCT_SCOPE.md](docs/PRODUCT_SCOPE.md) — qué es y qué no
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — capas y decisiones
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — cómo correr y validar
- [docs/WINDOWS_BUILD.md](docs/WINDOWS_BUILD.md) — instalador Windows
- [docs/UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md) — sync con Wave
- [docs/SECURITY.md](docs/SECURITY.md) — reglas y modelo de amenazas
- [docs/INVENTORY_WAVETERM.md](docs/INVENTORY_WAVETERM.md) — inventario del motor
- [docs/adr/](docs/adr/) — decisiones de arquitectura

Arranque rápido:

```bash
nexus/scripts/bootstrap.sh && task dev
cp nexus/config/environments.example.yaml nexus/config/environments.yaml
node nexus/scripts/import-environments.mjs --dev
```

## Cerebro Jarvis: no hay paso

Con `jarvisd` corriendo en la misma máquina **no hay que configurar nada**: el
bloque Jarvis apunta solo a `http://127.0.0.1:8770` (jarvisd sin token bindea
en loopback y no pide auth). Tampoco hay que reiniciar la app si la config
cambia: el runtime se reemplaza en caliente (ADR-0007, addendum M3).

Solo para casos que se salen del default:

| Quiero | Cómo |
|---|---|
| Cerebro en otra máquina | `NEXUS_DESKTOP_BRAIN_URL=http://host:8770`, o el setting `nexus:jarvisbrainurl` |
| Cerebro con token | `NEXUS_BRAIN_TOKEN=…`, o el setting `nexus:jarvisbraintoken` |
| Volver al mock etiquetado | `nexus:jarvisbrainenabled: false` |

Precedencia: **setting > variable de ambiente > default**. Si el cerebro no
contesta, el bloque dice "cerebro no conectado" y ofrece Reintentar; nunca
finge estar vivo cayendo al mock.

## Actualizaciones

La app se actualiza sola desde las GitHub Releases del fork (D-026): las betas
se publican automáticamente y el updater las descarga y ofrece instalar. No hay
que reinstalar a mano en cada versión. Detalle de canales en
[docs/UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md).
