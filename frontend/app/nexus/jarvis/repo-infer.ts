// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

export interface RepoInference {
    repo?: string;
    environmentId?: string;
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// workspaces con "~" no se pueden expandir sin conocer el home remoto: se
// omiten antes que adivinar (regla: no inventar contexto)
export function inferRepo(cwd: string, connection: string, environments: NexusEnvType[]): RepoInference {
    if (!cwd) {
        return {};
    }
    const normCwd = normalizePath(cwd);
    for (const env of environments ?? []) {
        if ((env.conn ?? "") != (connection ?? "")) {
            continue;
        }
        for (const workspace of env.workspaces ?? []) {
            if (workspace.startsWith("~")) {
                continue;
            }
            const root = normalizePath(workspace);
            if (!normCwd.toLowerCase().startsWith(root.toLowerCase() + "/")) {
                continue;
            }
            const rest = normCwd.slice(root.length + 1);
            const firstSegment = rest.split("/")[0];
            if (!firstSegment) {
                continue;
            }
            return { repo: `${root}/${firstSegment}`, environmentId: env.id };
        }
    }
    const envMatch = (environments ?? []).find((env) => (env.conn ?? "") == (connection ?? ""));
    return envMatch ? { environmentId: envMatch.id } : {};
}
