// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type {
    PermissionDecision,
    PermissionStoreData,
    SitePermissionRecord,
    WorkbenchPermission,
} from "@/app/nexus/permissions/permission-types";
import {
    buildPermissionCheckContext,
    buildPermissionContext,
    isAutoAllowedPermission,
    validatePermissionRequest,
} from "@/app/nexus/permissions/permission-policy";
import * as electron from "electron";
import fs from "fs";
import path from "path";

const StoreFile = "nexus-permissions.json";
const ValidPermissions = new Set<WorkbenchPermission>(["microphone", "camera", "notifications", "display-capture"]);
const ValidDecisions = new Set<PermissionDecision>(["allow", "deny", "ask", "block"]);

function emptyStore(): PermissionStoreData {
    return { version: 1, sites: [] };
}

function sanitizeStore(raw: any): PermissionStoreData {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.sites)) {
        return emptyStore();
    }
    const sites = raw.sites.filter((rec: any) => {
        return (
            typeof rec?.origin === "string" &&
            ValidPermissions.has(rec.permission) &&
            ValidDecisions.has(rec.decision) &&
            typeof rec.updatedAt === "number"
        );
    });
    return { version: 1, sites };
}

export class PermissionStore {
    private filePath: string;
    private data: PermissionStoreData = emptyStore();

    constructor(configDir: string) {
        this.filePath = path.join(configDir, StoreFile);
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) {
                this.data = emptyStore();
                return;
            }
            this.data = sanitizeStore(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
        } catch (e) {
            console.log("[permissions] configuración inválida, usando permisos vacíos", e instanceof Error ? e.message : e);
            this.data = emptyStore();
        }
    }

    save() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    list(): SitePermissionRecord[] {
        return [...this.data.sites].sort((a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission));
    }

    get(origin: string, permission: WorkbenchPermission): SitePermissionRecord | null {
        return this.data.sites.find((rec) => rec.origin === origin && rec.permission === permission) ?? null;
    }

    set(origin: string, permission: WorkbenchPermission, decision: PermissionDecision, moduleId?: string) {
        const current = this.get(origin, permission);
        if (current) {
            current.decision = decision;
            current.moduleId = moduleId ?? current.moduleId;
            current.updatedAt = Date.now();
        } else {
            this.data.sites.push({ origin, permission, decision, moduleId, updatedAt: Date.now() });
        }
        this.save();
    }

    revoke(origin: string, permission: WorkbenchPermission) {
        this.data.sites = this.data.sites.filter((rec) => !(rec.origin === origin && rec.permission === permission));
        this.save();
    }

    revokeAll(permission?: WorkbenchPermission) {
        this.data.sites = permission ? this.data.sites.filter((rec) => rec.permission !== permission) : [];
        this.save();
    }
}

let permissionStore: PermissionStore | null = null;

export function initPermissionStore(configDir: string) {
    permissionStore = new PermissionStore(configDir);
}

export function getPermissionStore(): PermissionStore {
    if (!permissionStore) {
        permissionStore = new PermissionStore(electron.app.getPath("userData"));
    }
    return permissionStore;
}

function permissionLabel(permission: WorkbenchPermission): string {
    switch (permission) {
        case "microphone":
            return "micrófono";
        case "camera":
            return "cámara";
        case "notifications":
            return "notificaciones";
        case "display-capture":
            return "compartir pantalla";
    }
}

export async function promptForPermission(opts: {
    origin: string;
    permission: WorkbenchPermission;
    moduleId?: string;
    parent?: Electron.BrowserWindow | null;
}): Promise<PermissionDecision> {
    const label = permissionLabel(opts.permission);
    const result = await electron.dialog.showMessageBox(opts.parent ?? undefined, {
        type: "question",
        title: "Permiso del sitio",
        message: `${opts.origin} solicita acceso al ${label}.`,
        detail: `Módulo: ${opts.moduleId ?? "web"}\nPodés revocar este permiso desde Configuración > Privacidad y permisos.`,
        buttons: ["Permitir", "Rechazar", "Bloquear dominio"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    });
    if (result.response === 0) {
        return "allow";
    }
    if (result.response === 2) {
        return "block";
    }
    return "deny";
}

export function initPermissionIpc() {
    electron.ipcMain.handle("nexus-permissions-list", () => getPermissionStore().list());
    electron.ipcMain.handle("nexus-permissions-set", (_event, rec: SitePermissionRecord) => {
        if (!rec || !ValidPermissions.has(rec.permission) || !ValidDecisions.has(rec.decision)) {
            throw new Error("invalid permission record");
        }
        getPermissionStore().set(rec.origin, rec.permission, rec.decision, rec.moduleId);
        return getPermissionStore().list();
    });
    electron.ipcMain.handle("nexus-permissions-revoke", (_event, origin: string, permission: WorkbenchPermission) => {
        if (typeof origin !== "string" || !ValidPermissions.has(permission)) {
            throw new Error("invalid permission revoke request");
        }
        getPermissionStore().revoke(origin, permission);
        return getPermissionStore().list();
    });
    electron.ipcMain.handle("nexus-permissions-revoke-all", (_event, permission?: WorkbenchPermission) => {
        if (permission != null && !ValidPermissions.has(permission)) {
            throw new Error("invalid permission");
        }
        getPermissionStore().revokeAll(permission);
        return getPermissionStore().list();
    });
}

function safeLog(parts: Record<string, string | undefined>) {
    console.log(
        `[permissions] module=${parts.moduleId ?? "web"} origin=${parts.origin ?? "unknown"} permission=${parts.permission ?? "unknown"} result=${parts.result ?? "unknown"} reason=${parts.reason ?? ""}`
    );
}

export function installSessionPermissionHandlers(sess: Electron.Session, opts: { partition?: string; moduleId?: string }) {
    sess.setPermissionRequestHandler((wc, electronPermission, callback, details) => {
        const ctx = buildPermissionContext(electronPermission, details as any, {
            partition: opts.partition,
            moduleId: opts.moduleId,
            fallbackUrl: wc?.getURL?.(),
        });
        if (!ctx) {
            if (isAutoAllowedPermission(electronPermission)) {
                safeLog({ moduleId: opts.moduleId, permission: electronPermission, result: "allowed", reason: "auto" });
                callback(true);
                return;
            }
            safeLog({ moduleId: opts.moduleId, permission: electronPermission, result: "blocked", reason: "unsupported" });
            callback(false);
            return;
        }
        const policyBlock = validatePermissionRequest(ctx);
        if (policyBlock) {
            safeLog({
                moduleId: ctx.moduleId,
                origin: ctx.origin,
                permission: ctx.permission,
                result: "blocked",
                reason: policyBlock.reason,
            });
            callback(false);
            return;
        }
        const store = getPermissionStore();
        const existing = store.get(ctx.origin, ctx.permission);
        if (existing?.decision === "allow") {
            safeLog({ moduleId: ctx.moduleId, origin: ctx.origin, permission: ctx.permission, result: "allowed", reason: "stored" });
            callback(true);
            return;
        }
        if (existing?.decision === "deny" || existing?.decision === "block") {
            safeLog({ moduleId: ctx.moduleId, origin: ctx.origin, permission: ctx.permission, result: "denied", reason: existing.decision });
            callback(false);
            return;
        }
        promptForPermission({
            origin: ctx.origin,
            permission: ctx.permission,
            moduleId: ctx.moduleId,
            parent: electron.BrowserWindow.fromWebContents(wc) ?? undefined,
        })
            .then((decision) => {
                store.set(ctx.origin, ctx.permission, decision, ctx.moduleId);
                const allowed = decision === "allow";
                safeLog({
                    moduleId: ctx.moduleId,
                    origin: ctx.origin,
                    permission: ctx.permission,
                    result: allowed ? "allowed" : "denied",
                    reason: decision,
                });
                callback(allowed);
            })
            .catch((e) => {
                safeLog({
                    moduleId: ctx.moduleId,
                    origin: ctx.origin,
                    permission: ctx.permission,
                    result: "denied",
                    reason: e instanceof Error ? e.message : "prompt-error",
                });
                callback(false);
            });
    });

    sess.setPermissionCheckHandler((wc, electronPermission, origin, details) => {
        const ctx = buildPermissionCheckContext(electronPermission, details as any, {
            partition: opts.partition,
            moduleId: opts.moduleId,
            fallbackUrl: origin || wc?.getURL?.(),
        });
        if (!ctx || !ctx.secure) {
            return isAutoAllowedPermission(electronPermission);
        }
        const store = getPermissionStore();
        return ctx.permissions.some((permission) => store.get(ctx.origin, permission)?.decision === "allow");
    });
}
