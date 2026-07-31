// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getSpatialBus } from "./spatial-bus";
import { isDetachedModule, SpatialModel } from "./spatial-model";

// Fachada `workspace.*` (CONTRACTS §3): wrappers finos sobre las RPCs
// Spatial*, reutilizable por UI, Jarvis y tests. Cada llamada emite
// jarvis.commandReceived en el bus para trazabilidad.
function traceCommand(command: string, args: unknown): void {
    getSpatialBus().emit("jarvis.commandReceived", { command, args });
}

function currentWorkspaceId(): string {
    return SpatialModel.getInstance().workspaceId;
}

export const workspace = {
    async focusModule(moduleId: string): Promise<void> {
        traceCommand("focusModule", { moduleId });
        await RpcApi.SpatialFocusCommand(TabRpcClient, { moduleid: moduleId });
    },

    async restoreModule(moduleId: string): Promise<void> {
        traceCommand("restoreModule", { moduleId });
        await RpcApi.SpatialRestoreCommand(TabRpcClient, { moduleid: moduleId });
    },

    async detachModule(
        moduleId: string,
        opts?: { monitorId?: string; placement?: SpatialPlacement; fill?: boolean }
    ): Promise<string> {
        traceCommand("detachModule", { moduleId, ...opts });
        return RpcApi.SpatialDetachCommand(TabRpcClient, {
            moduleid: moduleId,
            monitorid: opts?.monitorId,
            placement: opts?.placement,
            fill: opts?.fill,
        });
    },

    async attachModule(moduleId: string): Promise<void> {
        traceCommand("attachModule", { moduleId });
        await RpcApi.SpatialAttachCommand(TabRpcClient, { moduleid: moduleId });
    },

    async moveModule(moduleId: string, target: { monitorId?: string; placement?: SpatialPlacement }): Promise<void> {
        traceCommand("moveModule", { moduleId, ...target });
        await RpcApi.SpatialMoveCommand(TabRpcClient, {
            moduleid: moduleId,
            monitorid: target?.monitorId,
            placement: target?.placement,
        });
    },

    async minimizeModule(moduleId: string, minimized: boolean): Promise<void> {
        traceCommand("minimizeModule", { moduleId, minimized });
        await RpcApi.SpatialSetMinimizedCommand(TabRpcClient, { moduleid: moduleId, minimized });
    },

    // Detached se cierra vía engine (limpia estado espacial + ventana con
    // política engineClosing); acoplado delega en el cierre estándar de
    // bloques (CONTRACTS §3).
    async closeModule(moduleId: string): Promise<void> {
        traceCommand("closeModule", { moduleId });
        if (isDetachedModule(moduleId)) {
            await RpcApi.SpatialCloseModuleCommand(TabRpcClient, { moduleid: moduleId });
            return;
        }
        await RpcApi.DeleteBlockCommand(TabRpcClient, { blockid: moduleId });
    },

    async listMonitors(): Promise<MonitorInfo[]> {
        traceCommand("listMonitors", {});
        return RpcApi.SpatialListMonitorsCommand(TabRpcClient);
    },

    async saveLayout(profileName: string): Promise<void> {
        traceCommand("saveLayout", { profileName });
        await RpcApi.SpatialSaveProfileCommand(TabRpcClient, {
            name: profileName,
            workspaceid: currentWorkspaceId(),
        });
    },

    async loadLayout(profileName: string): Promise<void> {
        traceCommand("loadLayout", { profileName });
        await RpcApi.SpatialLoadProfileCommand(TabRpcClient, {
            name: profileName,
            workspaceid: currentWorkspaceId(),
        });
    },

    async listLayouts(): Promise<string[]> {
        traceCommand("listLayouts", {});
        return RpcApi.SpatialListProfilesCommand(TabRpcClient);
    },
};
