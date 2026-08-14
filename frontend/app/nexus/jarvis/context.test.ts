// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { RpcApi } from "@/app/store/wshclientapi";
import { captureFocusedContext, describeContext } from "./context";

function mockRpc(handlers: Record<string, (data: any, opts?: RpcOpts) => any>) {
    RpcApi.setMockRpcClient({
        mockWshRpcCall: async (_client, command, data, opts) => {
            const handler = handlers[command];
            if (!handler) {
                throw new Error(`sin mock para ${command}`);
            }
            return handler(data, opts);
        },
        mockWshRpcStream: null,
    });
}

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-test", windowId: "win-test" } as GlobalInitOptions);
});

afterEach(() => {
    RpcApi.setMockRpcClient(null);
});

describe("captureFocusedContext", () => {
    it("captures a rich terminal context", async () => {
        mockRpc({
            getfocusedblockdata: () => ({
                blockid: "b-1",
                viewtype: "term",
                connname: "rig3060",
                blockmeta: { "cmd:cwd": "/home/ndf/workspace/idp-platform", "frame:title": "DPI", "jarvis:mission": "m-9" },
                termlastcommand: "pytest -q",
            }),
            getrtinfo: () => ({ "shell:state": "ready", "shell:lastcmdexitcode": 0 }),
            termgetscrollbacklines: () => ({ lines: ["12 passed", "done"], totallines: 2, linestart: 0, lastupdated: 0 }),
        });
        const ctx = await captureFocusedContext();
        expect(ctx).toMatchObject({
            kind: "terminal",
            blockid: "b-1",
            connection: "rig3060",
            cwd: "/home/ndf/workspace/idp-platform",
            title: "DPI",
            shellstate: "ready",
            lastcommand: "pytest -q",
            lastexitcode: 0,
            jarvismission: "m-9",
        });
        expect((ctx as any).recentoutput).toContain("12 passed");
    });

    it("caps the recent output size", async () => {
        mockRpc({
            getfocusedblockdata: () => ({ blockid: "b-1", viewtype: "term", connname: "", blockmeta: {} }),
            getrtinfo: () => ({}),
            termgetscrollbacklines: () => ({ lines: ["x".repeat(10000)], totallines: 1, linestart: 0, lastupdated: 0 }),
        });
        const ctx = await captureFocusedContext();
        expect((ctx as any).recentoutput.length).toBeLessThanOrEqual(4000);
    });

    it("captures a web context with domain", async () => {
        mockRpc({
            getfocusedblockdata: () => ({
                blockid: "b-2",
                viewtype: "web",
                blockmeta: { url: "https://chatgpt.com/c/abc", "nexus:web:title": "Charla" },
            }),
        });
        const ctx = await captureFocusedContext();
        expect(ctx).toEqual({ kind: "web", blockid: "b-2", url: "https://chatgpt.com/c/abc", title: "Charla", domain: "chatgpt.com" });
    });

    it("routes the focused-block query to the tab handler", async () => {
        let seenRoute: string;
        mockRpc({
            getfocusedblockdata: (_data, opts) => {
                seenRoute = opts?.route;
                return { blockid: "b-2", viewtype: "web", blockmeta: { url: "https://x.dev/p" } };
            },
        });
        await captureFocusedContext();
        expect(seenRoute).toBe("tab:tab-test");
    });

    it("returns empty for unsupported views and rpc failures", async () => {
        mockRpc({ getfocusedblockdata: () => ({ blockid: "b-3", viewtype: "preview", blockmeta: {} }) });
        expect(await captureFocusedContext()).toEqual({ kind: "empty" });
        mockRpc({
            getfocusedblockdata: () => {
                throw new Error("boom");
            },
        });
        expect(await captureFocusedContext()).toEqual({ kind: "empty" });
    });
});

describe("describeContext", () => {
    it("renders human labels", () => {
        expect(describeContext({ kind: "empty" })).toBe("sin contexto");
        expect(
            describeContext({ kind: "terminal", blockid: "b", connection: "rig3060", repo: "/home/ndf/workspace/idp-platform" })
        ).toBe("Terminal · rig3060 · idp-platform");
        expect(describeContext({ kind: "web", blockid: "b", url: "https://x.dev/p", domain: "x.dev", title: "Doc" })).toBe(
            "Web · x.dev · Doc"
        );
    });
});
