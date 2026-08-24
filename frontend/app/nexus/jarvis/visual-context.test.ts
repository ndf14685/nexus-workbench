// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// El contrato que ve el cerebro: metadata de fuentes visuales, nunca imagen.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { atoms, globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import type { AIVisionMode, VisualSourceConfig } from "@/app/nexus/visual/visual-types";
import {
    buildVisualSourcesContext,
    captureFocusedContext,
    captureVisualSources,
    describeContext,
    type OpenVisualBlock,
} from "./context";

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

function seedSettings(sources: unknown[]) {
    const full = globalStore.get(atoms.fullConfigAtom) ?? ({} as FullConfigType);
    globalStore.set(atoms.fullConfigAtom, {
        ...full,
        settings: { ...(full.settings ?? {}), "nexus:visualsources": sources },
    } as FullConfigType);
}

const bancoSource: VisualSourceConfig = {
    id: "hdmi-primary",
    type: "uvc",
    label: "Banco",
    device: { name: "USB Video", vid: "534d", pid: "2109" },
    aivision: "on_demand",
};

const openBanco: OpenVisualBlock = {
    blockId: "b-hmi",
    sourceId: "hdmi-primary",
    status: "live",
    available: true,
};

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-visual", windowId: "win-visual" } as GlobalInitOptions);
});

afterEach(() => {
    RpcApi.setMockRpcClient(null);
});

describe("catalogo de fuentes visuales", () => {
    it("publica metadata y NUNCA imagen", () => {
        const ctx = buildVisualSourcesContext([bancoSource], []);
        expect(ctx.kind).toBe("visual_sources");
        expect((ctx as any).sources[0]).toMatchObject({
            id: "hdmi-primary",
            label: "Banco",
            type: "uvc",
            ai_vision: "on_demand",
            visible: false,
            focused: false,
            status: "closed",
        });
        // el contrato es metadata: cualquier campo de imagen seria un bug
        expect(JSON.stringify(ctx)).not.toMatch(/image|base64|frame/i);
    });

    it("marca visible y focused segun el bloque abierto", () => {
        const sinFoco = buildVisualSourcesContext([bancoSource], [openBanco]) as any;
        expect(sinFoco.sources[0]).toMatchObject({ visible: true, focused: false, status: "live", available: true });

        const conFoco = buildVisualSourcesContext([bancoSource], [openBanco], "b-hmi") as any;
        expect(conFoco.sources[0].focused).toBe(true);
    });

    it("no afirma disponibilidad si el bloque no reporta estado", () => {
        // El renderer no puede saber si la capturadora esta enchufada sin abrir
        // el stream; inventarlo seria mentirle al cerebro.
        const ctx = buildVisualSourcesContext(
            [bancoSource],
            [{ blockId: "b-hmi", sourceId: "hdmi-primary", status: "unknown" }]
        ) as any;
        expect(ctx.sources[0].available).toBeUndefined();
        expect(ctx.sources[0].status).toBe("unknown");
    });

    it("una fuente sin bloque abierto queda closed aunque otra si lo tenga", () => {
        const ctx = buildVisualSourcesContext([bancoSource, { id: "hdmi-lab", label: "Lab" }], [openBanco]) as any;
        expect(ctx.sources[0].visible).toBe(true);
        expect(ctx.sources[1]).toMatchObject({ id: "hdmi-lab", visible: false, status: "closed" });
    });

    it("sin fuentes configuradas no agrega ruido al contexto", () => {
        expect(buildVisualSourcesContext([], []).kind).toBe("empty");
        seedSettings([]);
        expect(captureVisualSources().kind).toBe("empty");
    });

    it("respeta ai_vision off", () => {
        const ctx = buildVisualSourcesContext([{ ...bancoSource, aivision: "off" }], []) as any;
        expect(ctx.sources[0].ai_vision).toBe("off");
    });

    it("normaliza un modo invalido a on_demand en vez de propagarlo", () => {
        const ctx = buildVisualSourcesContext([{ ...bancoSource, aivision: "continuous" as AIVisionMode }], []) as any;
        expect(ctx.sources[0].ai_vision).toBe("on_demand");
    });
});

describe("bloque HMI enfocado", () => {
    it("resuelve la deixis a la fuente de ese bloque", async () => {
        seedSettings([bancoSource, { id: "hdmi-lab", label: "Lab" }]);
        mockRpc({
            getfocusedblockdata: () => ({
                blockid: "b-hmi",
                viewtype: "visual",
                blockmeta: { view: "visual", "visual:source": "hdmi-lab" },
            }),
        });
        const ctx = await captureFocusedContext();
        expect(ctx).toMatchObject({
            kind: "visual",
            blockid: "b-hmi",
            sourceid: "hdmi-lab",
            label: "Lab",
            aivision: "on_demand",
        });
        expect(describeContext(ctx)).toContain("Lab");
    });

    it("un bloque sin fuente fijada usa la primera configurada", async () => {
        seedSettings([bancoSource]);
        mockRpc({
            getfocusedblockdata: () => ({ blockid: "b-hmi", viewtype: "visual", blockmeta: { view: "visual" } }),
        });
        expect(await captureFocusedContext()).toMatchObject({ kind: "visual", sourceid: "hdmi-primary" });
    });

    it("sin fuentes configuradas el bloque no aporta contexto", async () => {
        seedSettings([]);
        mockRpc({
            getfocusedblockdata: () => ({ blockid: "b-hmi", viewtype: "visual", blockmeta: { view: "visual" } }),
        });
        expect((await captureFocusedContext()).kind).toBe("empty");
    });
});
