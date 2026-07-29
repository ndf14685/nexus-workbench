# ADR-0002: Frontera del Workbench Core y contrato del Bridge

- Estado: Aceptada
- Fecha: 2026-07-28

## Contexto

Las funcionalidades propias (catálogo de ambientes, workspaces declarativos,
comandos/runbooks) no deben depender de internals de Wave, ni vivir dispersas
en componentes React, ni quedar presas de la SQLite interna.

## Decisión

1. **Workbench Core = datos declarativos y versionables** en
   `nexus/config/*.yaml` (ambientes, workspaces, comandos). La fuente de
   verdad es Git, no la base interna del motor.
2. **El Core se proyecta al motor por el Bridge**, nunca al revés. Hoy el
   Bridge tiene dos superficies:
   - *Config projection* (implementada): `nexus/scripts/import-environments.mjs`
     escribe `connections.json` y `presets.json` — archivos de config pública
     y estable de Wave (con watcher fsnotify: la app los toma en caliente).
   - *RPC contract* (documentado, no implementado): interfaz TS
     `WorkbenchBridge` (ver `BRIDGE.md`) cuya implementación natural es el
     cliente wshrpc generado (`frontend/app/store/wshclientapi.ts`).
3. **Prohibido** poner lógica de negocio propia dentro de componentes React
   del árbol de Wave; si en el futuro se agrega UI propia, será un bloque
   nuevo registrado en `blockregistry.ts` que consume el Bridge.
4. Nada del Core asume que el motor es Wave más allá del Bridge: cambiar de
   motor = reimplementar el Bridge (proyección + contrato RPC).

## Consecuencias

- (+) La config personal sobrevive a reinstalaciones, machines y al propio
  motor; se revisa por PR y se versiona.
- (+) El diff dentro del árbol de Wave se mantiene mínimo.
- (−) Doble representación (YAML propio ↔ JSON de Wave) con sincronización
  unidireccional manual (aceptado para el MVP; backlog: watch/re-import).
