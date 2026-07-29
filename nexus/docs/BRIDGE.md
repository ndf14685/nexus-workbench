# Workbench Bridge — contrato

> Estado: **contrato documentado**. Solo la proyección de config está
> implementada hoy (`nexus/scripts/import-environments.mjs`). El resto es
> backlog deliberado (ver ADR-0002): no se abstrae lo que aún no se usa.

## Interfaz objetivo

```ts
// Tipos del dominio Workbench (motor-agnósticos)
type EnvClass = "lab" | "personal" | "work" | "prod";

interface WorkbenchEnvironment {
    id: string;
    name: string;
    kind: "local" | "wsl" | "ssh";
    host?: string;      // alias de ~/.ssh/config (ssh)
    distro?: string;    // (wsl)
    class: EnvClass;
    criticality: "low" | "medium" | "high";
}

interface WorkbenchBridge {
    openTerminal(env: WorkbenchEnvironment, cwd?: string): Promise<string>; // blockId
    openConnection(env: WorkbenchEnvironment): Promise<void>;
    openRemoteFile(env: WorkbenchEnvironment, path: string): Promise<string>; // blockId
    createWorkspace(def: WorkspaceDef): Promise<string>;   // workspaceId
    restoreWorkspace(id: string): Promise<void>;
    showLogs(env: WorkbenchEnvironment, spec: LogSpec): Promise<string>;
    runCommand(env: WorkbenchEnvironment, cmd: CommandDef): Promise<RunResult>;
    getActiveEnvironment(): Promise<WorkbenchEnvironment | null>;
    getTerminalContext(blockId: string): Promise<TerminalContext>;
}
```

## Mapeo a primitivas reales de Wave (verificado en el código)

| Operación | Primitiva del motor |
|---|---|
| `openTerminal` | servicio `ObjectService`/`wcore.CreateBlock` con `blockdef.meta = { view: "term", connection: <host \| wsl://distro> }`; vía RPC `CreateBlockCommand` (`pkg/wshrpc/wshrpctypes.go`) |
| `openConnection` | `ConnConnectCommand` (conncontroller) |
| `openRemoteFile` | bloque `view: "preview"` con `connection` + `file` |
| `createWorkspace` / `restoreWorkspace` | `pkg/wcore/workspace.go` (`CreateWorkspace`, `ApplyPortableLayout`) — expuesto por `WorkspaceService` |
| `showLogs` | `openTerminal` + comando (`journalctl -f`, `docker logs -f`) |
| `runCommand` | bloque term con `cmd` en meta, o `wsh run` — **siempre con confirmación si `destructive` o class ∈ {prod, work}** |
| `getActiveEnvironment` | conexión del bloque activo (`atoms` de Jotai / `block.meta.connection`) mapeada contra el catálogo |
| `getTerminalContext` | `term-model.ts` (título, cwd vía OSC, conexión) |

## Reglas

- El Bridge es la **única** puerta entre el Core y el motor.
- Los hooks de policy/audit de NexusOS (ADR-0004) se interpondrán aquí.
- Implementar métodos **solo cuando una feature real los necesite**.
