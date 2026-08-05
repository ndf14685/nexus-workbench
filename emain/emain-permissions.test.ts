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
    // shape captured from Electron 41 for a <webview> guest: the origin argument and requestingUrl
    // are empty strings, only embeddingOrigin carries the site
    const guestDetails = (mediaType?: string) => ({
        embeddingOrigin: "https://chatgpt.com/",
        requestingUrl: "",
        isMainFrame: true,
        ...(mediaType ? { mediaType } : {}),
    });

    it("does not report the microphone as denied before the user was ever asked", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        expect(check(wc, "media", "", guestDetails("audio"))).toBe(true);
        expect(check(wc, "media", "", guestDetails())).toBe(true);
    });

    it("keeps reporting granted once the microphone was allowed", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        getPermissionStore().set("https://chatgpt.com", "microphone", "allow", "browser");
        expect(check(wc, "media", "", guestDetails("audio"))).toBe(true);
    });

    it("reports denied only after an explicit denial", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        getPermissionStore().set("https://chatgpt.com", "microphone", "deny", "browser");
        expect(check(wc, "media", "", guestDetails("audio"))).toBe(false);
        getPermissionStore().set("https://chatgpt.com", "microphone", "block", "browser");
        expect(check(wc, "media", "", guestDetails("audio"))).toBe(false);
    });

    it("keeps camera and microphone denials independent", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        getPermissionStore().set("https://chatgpt.com", "camera", "block", "browser");
        expect(check(wc, "media", "", guestDetails("video"))).toBe(false);
        expect(check(wc, "media", "", guestDetails("audio"))).toBe(true);
    });

    it("denies insecure origins outright", () => {
        initPermissionStore(tmp());
        const { check } = installHandlers();
        expect(check(wc, "media", "", { embeddingOrigin: "http://example.com/", requestingUrl: "", mediaType: "audio" })).toBe(false);
    });

    it("still gates the actual capture through the request handler", async () => {
        initPermissionStore(tmp());
        const { request } = installHandlers();
        getPermissionStore().set("https://chatgpt.com", "microphone", "block", "browser");
        const allowed = await new Promise((resolve) => {
            request(wc, "media", resolve, {
                securityOrigin: "https://chatgpt.com/",
                requestingUrl: "https://chatgpt.com/",
                isMainFrame: true,
                mediaTypes: ["audio"],
            });
        });
        expect(allowed).toBe(false);
    });
});
