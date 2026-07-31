// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Workspace capabilities the Workbench registers with the brain (Jarvis
// Protocol v1.1 §3) and the dispatcher that executes brain-invoked
// `capability.invoke` events against the spatial `workspace.*` facade.
// This module is PURE (no Wave imports): the live facade + module resolver
// bindings live in jarvis-capabilities-live.ts and are injected/lazy-loaded
// by HttpJarvisRuntime, so tests can supply mocks.
//
// Wire dialect: the payloads here (params_schema, risk_class, client_id…) are
// snake_case because the Jarvis Protocol v1.1 contract is owned by the brain
// (Python convention). The repo's lowercase-JSON rule applies to Wave types,
// not to this external protocol.

export type ClientCapabilityRiskClass = "read" | "reversible-write" | "irreversible-write";

export type ClientCapabilityDecl = {
    name: string;
    description: string;
    params_schema: Record<string, unknown>;
    risk_class: ClientCapabilityRiskClass;
};

// Structural subset of the spatial-api `workspace` facade that capabilities
// need; the real object satisfies it as-is.
export type WorkspaceFacade = {
    loadLayout(name: string): Promise<void>;
    saveLayout(name: string): Promise<void>;
    focusModule(moduleId: string): Promise<void>;
    restoreModule(moduleId: string): Promise<void>;
    detachModule(moduleId: string, opts?: { monitorId?: string }): Promise<string>;
    attachModule(moduleId: string): Promise<void>;
    moveModule(moduleId: string, target: { monitorId?: string }): Promise<void>;
    listMonitors(): Promise<unknown[]>;
    listLayouts(): Promise<string[]>;
};

// Maps a brain-sent module reference to a concrete blockId, or null if it
// cannot be resolved. Accepts a blockId directly or a friendly module type
// ("term", "jarvis", …) resolved against the active tab.
export type ModuleResolver = (ref: string) => string | null;

const ModuleIdSchema = {
    type: "string",
    description:
        "blockId del módulo, o tipo de módulo ('term', 'jarvis', 'preview', …) que se resuelve al primer bloque de ese tipo del tab activo",
};

const MonitorIdSchema = {
    type: "string",
    description: "id del monitor destino (opcional)",
};

const NameSchema = { type: "string", description: "nombre del layout" };

function moduleParams(withMonitor: boolean): Record<string, unknown> {
    const properties: Record<string, unknown> = { moduleid: ModuleIdSchema };
    if (withMonitor) {
        properties["monitorid"] = MonitorIdSchema;
    }
    return { type: "object", properties, required: ["moduleid"] };
}

export const WorkspaceCapabilities: ClientCapabilityDecl[] = [
    {
        name: "workspace.loadLayout",
        description: "Aplica un layout espacial guardado del workspace",
        params_schema: { type: "object", properties: { name: NameSchema }, required: ["name"] },
        risk_class: "reversible-write",
    },
    {
        name: "workspace.saveLayout",
        description: "Guarda el layout espacial actual del workspace con un nombre",
        params_schema: { type: "object", properties: { name: NameSchema }, required: ["name"] },
        risk_class: "reversible-write",
    },
    {
        name: "workspace.focusModule",
        description: "Enfoca un módulo del workspace",
        params_schema: moduleParams(false),
        risk_class: "reversible-write",
    },
    {
        name: "workspace.restoreModule",
        description: "Restaura (des-minimiza / pop-in) un módulo del workspace",
        params_schema: moduleParams(false),
        risk_class: "reversible-write",
    },
    {
        name: "workspace.detachModule",
        description: "Separa un módulo a una ventana propia, opcionalmente en un monitor",
        params_schema: moduleParams(true),
        risk_class: "reversible-write",
    },
    {
        name: "workspace.attachModule",
        description: "Reincorpora un módulo separado a la ventana principal",
        params_schema: moduleParams(false),
        risk_class: "reversible-write",
    },
    {
        name: "workspace.moveModule",
        description: "Mueve un módulo separado a otro monitor",
        params_schema: moduleParams(true),
        risk_class: "reversible-write",
    },
    {
        name: "workspace.listMonitors",
        description: "Lista los monitores conectados y su geometría",
        params_schema: { type: "object", properties: {} },
        risk_class: "read",
    },
    {
        name: "workspace.listLayouts",
        description: "Lista los layouts espaciales guardados",
        params_schema: { type: "object", properties: {} },
        risk_class: "read",
    },
];

function requireString(args: Record<string, unknown>, key: string): string {
    const value = args?.[key];
    if (typeof value !== "string" || value === "") {
        throw new Error(`falta el argumento '${key}'`);
    }
    return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
    const value = args?.[key];
    if (value == null || value === "") {
        return null;
    }
    if (typeof value !== "string") {
        throw new Error(`el argumento '${key}' debe ser string`);
    }
    return value;
}

function resolveModuleArg(args: Record<string, unknown>, resolveModule: ModuleResolver): string {
    const ref = requireString(args, "moduleid");
    const resolved = resolveModule(ref);
    if (!resolved) {
        throw new Error(`módulo desconocido: ${ref}`);
    }
    return resolved;
}

// Executes one brain-invoked capability. Returns the result object POSTed back
// as /capability/result.result; throws Error with a human (Spanish) message
// for the ok:false path. Unknown names throw "capability desconocida".
export async function executeWorkspaceCapability(
    name: string,
    args: Record<string, unknown>,
    facade: WorkspaceFacade,
    resolveModule: ModuleResolver
): Promise<Record<string, unknown>> {
    switch (name) {
        case "workspace.loadLayout": {
            const layout = requireString(args, "name");
            await facade.loadLayout(layout);
            return { loaded: true, name: layout };
        }
        case "workspace.saveLayout": {
            const layout = requireString(args, "name");
            await facade.saveLayout(layout);
            return { saved: true, name: layout };
        }
        case "workspace.focusModule": {
            const moduleId = resolveModuleArg(args, resolveModule);
            await facade.focusModule(moduleId);
            return { focused: moduleId };
        }
        case "workspace.restoreModule": {
            const moduleId = resolveModuleArg(args, resolveModule);
            await facade.restoreModule(moduleId);
            return { restored: moduleId };
        }
        case "workspace.detachModule": {
            const moduleId = resolveModuleArg(args, resolveModule);
            const monitorId = optionalString(args, "monitorid");
            const surfaceId = await facade.detachModule(moduleId, monitorId ? { monitorId } : undefined);
            return { detached: moduleId, surface: surfaceId ?? null };
        }
        case "workspace.attachModule": {
            const moduleId = resolveModuleArg(args, resolveModule);
            await facade.attachModule(moduleId);
            return { attached: moduleId };
        }
        case "workspace.moveModule": {
            const moduleId = resolveModuleArg(args, resolveModule);
            const monitorId = optionalString(args, "monitorid");
            await facade.moveModule(moduleId, monitorId ? { monitorId } : {});
            return { moved: moduleId, monitor: monitorId };
        }
        case "workspace.listMonitors": {
            return { monitors: await facade.listMonitors() };
        }
        case "workspace.listLayouts": {
            return { layouts: await facade.listLayouts() };
        }
        default: {
            throw new Error(`capability desconocida: ${name}`);
        }
    }
}
