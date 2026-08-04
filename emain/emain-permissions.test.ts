// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    app: { getPath: () => tmpdir() },
    ipcMain: { handle: vi.fn() },
    dialog: { showMessageBox: vi.fn() },
    BrowserWindow: { fromWebContents: vi.fn() },
}));

import { getPermissionStore, initPermissionStore, installSessionPermissionHandlers, PermissionStore } from "./emain-permissions";

let dirs: string[] = [];

function tmp() {
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-perms-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

describe("PermissionStore", () => {
    it("persists allowed microphone permission", () => {
        const dir = tmp();
        const store = new PermissionStore(dir);
        store.set("https://chatgpt.com", "microphone", "allow", "chatgpt");
        const reloaded = new PermissionStore(dir);
        expect(reloaded.get("https://chatgpt.com", "microphone")).toMatchObject({ decision: "allow", moduleId: "chatgpt" });
    });

    it("revokes individual and all permissions", () => {
        const store = new PermissionStore(tmp());
        store.set("https://chatgpt.com", "microphone", "allow", "chatgpt");
        store.set("https://claude.ai", "microphone", "allow", "claude");
        store.revoke("https://chatgpt.com", "microphone");
        expect(store.get("https://chatgpt.com", "microphone")).toBeNull();
        expect(store.get("https://claude.ai", "microphone")).not.toBeNull();
        store.revokeAll("microphone");
        expect(store.list()).toEqual([]);
    });

    it("loads invalid configuration as empty", () => {
        const dir = tmp();
        writeFileSync(path.join(dir, "nexus-permissions.json"), "{bad");
        expect(new PermissionStore(dir).list()).toEqual([]);
    });
});

function installHandlers() {
    let checkHandler: any;
    let requestHandler: any;
    const sess = {
        setPermissionRequestHandler: (h: any) => (requestHandler = h),
        setPermissionCheckHandler: (h: any) => (checkHandler = h),
    };
    installSessionPermissionHandlers(sess as any, { moduleId: "browser" });
    return { check: (...args: any[]) => checkHandler(...args), request: (...args: any[]) => requestHandler(...args) };
}

describe("session permission handlers", () => {
    const wc = { getURL: () => "https://chatgpt.com/" } as any;

    it("reports granted for navigator.permissions.query when the origin is allowed", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        check(wc, "media", "https://chatgpt.com", {
            securityOrigin: "https://chatgpt.com",
            requestingUrl: "https://chatgpt.com/",
            isMainFrame: true,
            mediaType: "audio",
        });
        // permissions.query() reaches Electron as a bare "media" check with no mediaType
        expect(
            check(wc, "media", "https://chatgpt.com", {
                securityOrigin: "https://chatgpt.com",
                requestingUrl: "https://chatgpt.com/",
                isMainFrame: true,
            })
        ).toBe(false);

        initPermissionStore(tmp());
        const granted = installHandlers();
        // grant the microphone the same way the prompt would
        getPermissionStore().set("https://chatgpt.com", "microphone", "allow", "browser");
        expect(
            granted.check(wc, "media", "https://chatgpt.com", {
                securityOrigin: "https://chatgpt.com",
                requestingUrl: "https://chatgpt.com/",
                isMainFrame: true,
            })
        ).toBe(true);
    });

    it("still answers a typed audio check from the stored decision", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        const details = {
            securityOrigin: "https://chatgpt.com",
            requestingUrl: "https://chatgpt.com/",
            isMainFrame: true,
            mediaType: "audio",
        };
        expect(check(wc, "media", "https://chatgpt.com", details)).toBe(false);
        getPermissionStore().set("https://chatgpt.com", "microphone", "allow", "browser");
        expect(check(wc, "media", "https://chatgpt.com", details)).toBe(true);
    });

    it("does not report camera as granted when only the microphone was allowed", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        getPermissionStore().set("https://chatgpt.com", "microphone", "allow", "browser");
        expect(
            check(wc, "media", "https://chatgpt.com", {
                securityOrigin: "https://chatgpt.com",
                requestingUrl: "https://chatgpt.com/",
                isMainFrame: true,
                mediaType: "video",
            })
        ).toBe(false);
    });
});
