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

import { PermissionStore } from "./emain-permissions";

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
