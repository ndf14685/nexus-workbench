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
