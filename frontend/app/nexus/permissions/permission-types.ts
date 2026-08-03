// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

export type WorkbenchPermission = "microphone" | "camera" | "notifications" | "display-capture";
export type PermissionDecision = "allow" | "deny" | "ask" | "block";

export type SitePermissionRecord = {
    origin: string;
    permission: WorkbenchPermission;
    decision: PermissionDecision;
    moduleId?: string;
    updatedAt: number;
};

export type PermissionStoreData = {
    version: 1;
    sites: SitePermissionRecord[];
};

export type PermissionRequestContext = {
    origin: string;
    url?: string;
    partition?: string;
    moduleId?: string;
    permission: WorkbenchPermission;
    secure: boolean;
};

export type PermissionRequestResult = {
    allowed: boolean;
    decision: PermissionDecision;
    reason: string;
};
