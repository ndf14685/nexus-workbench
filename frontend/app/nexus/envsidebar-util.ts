// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { canonicalizeConnName } from "./conn-name";

export const SidebarMinWidth = 160;
export const SidebarMaxWidth = 480;
export const SidebarDefaultWidth = 240;

export type EnvGroup = {
    title: string;
    envs: NexusEnvType[];
};

const GroupLocal = "Local";
const GroupServers = "Servidores";
const GroupOther = "Otros";

// Grouping is derived from `kind`, never from environment names, so any
// catalog (including future kinds) renders without hardcoding entries.
export function groupTitleForEnv(env: NexusEnvType): string {
    if (env.kind === "local" || env.kind === "wsl") {
        return GroupLocal;
    }
    if (env.kind === "ssh") {
        return GroupServers;
    }
    return GroupOther;
}

export function groupEnvironments(envs: NexusEnvType[]): EnvGroup[] {
    const order = [GroupLocal, GroupServers, GroupOther];
    const byTitle = new Map<string, NexusEnvType[]>();
    for (const env of envs ?? []) {
        if (env?.id == null) {
            continue;
        }
        const title = groupTitleForEnv(env);
        if (!byTitle.has(title)) {
            byTitle.set(title, []);
        }
        byTitle.get(title).push(env);
    }
    return order.filter((t) => byTitle.has(t)).map((title) => ({ title, envs: byTitle.get(title) }));
}

export function findEnvByConn(envs: NexusEnvType[], conn: string): NexusEnvType {
    if (conn == null) {
        return null;
    }
    const canon = canonicalizeConnName(conn);
    return (envs ?? []).find((e) => canonicalizeConnName(e.conn ?? "") === canon) ?? null;
}

export function defaultIconForEnv(env: NexusEnvType): string {
    switch (env.kind) {
        case "local":
            return "desktop";
        case "wsl":
            return "layer-group";
        case "ssh":
            return "server";
        default:
            return "circle-nodes";
    }
}

export const ClassColors: Record<string, string> = {
    lab: "#a371f7",
    personal: "#3fb950",
    work: "#58a6ff",
    prod: "#f85149",
};

export function colorForEnv(env: NexusEnvType): string {
    return env.color ?? ClassColors[env.class] ?? "#8b949e";
}

export type EnvConnState = "connected" | "connecting" | "error" | "disconnected" | "none";

// Local environments have no connection lifecycle: they are always usable, so
// they get "none" instead of a fake "connected".
export function connStateForEnv(env: NexusEnvType, connStatus: ConnStatus): EnvConnState {
    return connStateForConn(env.conn, connStatus);
}

export function connStateForConn(conn: string, connStatus: ConnStatus): EnvConnState {
    if (!conn) {
        return "none";
    }
    const status = connStatus?.status;
    if (status === "connected") {
        return "connected";
    }
    if (status === "connecting") {
        return "connecting";
    }
    if (status === "error" || connStatus?.error) {
        return "error";
    }
    return "disconnected";
}

export const ConnStateColors: Record<EnvConnState, string> = {
    connected: "#3fb950",
    connecting: "#d29922",
    error: "#f85149",
    disconnected: "#6e7681",
    none: "transparent",
};

export type EnvOpenAction = "focus" | "reconnect" | "create";

export type EnvOpenPlan = {
    action: EnvOpenAction;
    blockId?: string;
};

// Un click = terminal usable. Reenfocar un bloque cuya conexión está en error no
// alcanza: `EnsureConnection` cachea el error para siempre y solo
// ConnConnectCommand lo limpia (pkg/remote/conncontroller/conncontroller.go), así
// que el bloque vivo sobre una conexión muerta necesita reconexión explícita.
export function planEnvOpen(existingBlockId: string, connState: EnvConnState): EnvOpenPlan {
    if (!existingBlockId) {
        return { action: "create" };
    }
    if (connState === "error" || connState === "disconnected") {
        return { action: "reconnect", blockId: existingBlockId };
    }
    return { action: "focus", blockId: existingBlockId };
}

export function clampSidebarWidth(width: number): number {
    if (width == null || isNaN(width) || width === 0) {
        return SidebarDefaultWidth;
    }
    return Math.min(SidebarMaxWidth, Math.max(SidebarMinWidth, width));
}

export function toggleGroup(collapsedGroups: string[], title: string): string[] {
    const set = new Set(collapsedGroups ?? []);
    if (set.has(title)) {
        set.delete(title);
    } else {
        set.add(title);
    }
    return [...set];
}
