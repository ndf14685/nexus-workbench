// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { PermissionRequestContext, PermissionRequestResult, WorkbenchPermission } from "./permission-types";

export type ElectronPermissionDetails = {
    requestingUrl?: string;
    embeddingOrigin?: string;
    securityOrigin?: string;
    mediaTypes?: string[];
    mediaType?: string;
};

const PermissionNames = new Set(["media", "audioCapture", "videoCapture", "notifications", "display-capture"]);
const AutoAllowedPermissions = new Set(["clipboard-sanitized-write", "fullscreen", "storage-access", "top-level-storage-access"]);

export function isAutoAllowedPermission(permission: string): boolean {
    return AutoAllowedPermissions.has(permission);
}

export function normalizeOrigin(rawUrl?: string): string | null {
    if (!rawUrl) {
        return null;
    }
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === "file:" || parsed.protocol === "app:" || parsed.protocol === "wave:") {
            return `${parsed.protocol}//local`;
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

export function isSecurePermissionUrl(rawUrl?: string): boolean {
    if (!rawUrl) {
        return false;
    }
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === "https:") {
            return true;
        }
        if (parsed.protocol === "file:" || parsed.protocol === "app:" || parsed.protocol === "wave:") {
            return true;
        }
        return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    } catch {
        return false;
    }
}

export function permissionFromElectron(permission: string, details?: ElectronPermissionDetails): WorkbenchPermission | null {
    if (!PermissionNames.has(permission)) {
        return null;
    }
    if (permission === "notifications") {
        return "notifications";
    }
    if (permission === "display-capture") {
        return "display-capture";
    }
    if (permission === "audioCapture") {
        return "microphone";
    }
    if (permission === "videoCapture") {
        return "camera";
    }
    const types = details?.mediaTypes ?? (details?.mediaType ? [details.mediaType] : []);
    if (types.includes("video")) {
        return "camera";
    }
    if (types.includes("audio")) {
        return "microphone";
    }
    return null;
}

// navigator.permissions.query() and Chromium's generic media checks reach the check handler as a
// bare "media" permission with mediaType absent or "unknown", so the concrete capture device cannot
// be resolved. Answering "denied" there makes sites hide their mic button and never call
// getUserMedia, so the request handler never runs and the user never gets a prompt.
export function permissionsForCheck(permission: string, details?: ElectronPermissionDetails): WorkbenchPermission[] {
    if (!PermissionNames.has(permission)) {
        return [];
    }
    const resolved = permissionFromElectron(permission, details);
    if (resolved) {
        return [resolved];
    }
    return permission === "media" ? ["microphone", "camera"] : [];
}

export function buildPermissionCheckContext(
    electronPermission: string,
    details: ElectronPermissionDetails | undefined,
    opts: { partition?: string; moduleId?: string; fallbackUrl?: string }
): { origin: string; secure: boolean; permissions: WorkbenchPermission[] } | null {
    const permissions = permissionsForCheck(electronPermission, details);
    const url = details?.requestingUrl ?? details?.securityOrigin ?? details?.embeddingOrigin ?? opts.fallbackUrl;
    const origin = normalizeOrigin(url);
    if (permissions.length === 0 || !origin) {
        return null;
    }
    return { origin, secure: isSecurePermissionUrl(url), permissions };
}

export function buildPermissionContext(
    electronPermission: string,
    details: ElectronPermissionDetails | undefined,
    opts: { partition?: string; moduleId?: string; fallbackUrl?: string }
): PermissionRequestContext | null {
    const permission = permissionFromElectron(electronPermission, details);
    const url = details?.requestingUrl ?? details?.securityOrigin ?? details?.embeddingOrigin ?? opts.fallbackUrl;
    const origin = normalizeOrigin(url);
    if (!permission || !origin) {
        return null;
    }
    return {
        origin,
        url,
        partition: opts.partition,
        moduleId: opts.moduleId,
        permission,
        secure: isSecurePermissionUrl(url),
    };
}

export function validatePermissionRequest(ctx: PermissionRequestContext): PermissionRequestResult | null {
    if (!ctx.secure) {
        return { allowed: false, decision: "block", reason: "insecure-origin" };
    }
    return null;
}
