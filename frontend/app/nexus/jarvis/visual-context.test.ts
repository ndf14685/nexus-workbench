// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// El contrato que ve el cerebro: metadata de fuentes visuales, nunca imagen.

import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { atoms, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { ObjectService } from "@/app/store/services";
import { captureFocusedContext, captureVisualSources, describeContext } from "./context";

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

// Inyecta settings y objetos del store sin levantar backend.
function seedSettings(sources: unknown[]) {
    const full = globalStore.get(atoms.fullConfigAtom) ?? ({} as FullConfigType);
    globalStore.set(atoms.fullConfigAtom, {
        ...full,
        settings: { ...(full.settings ?? {}), "nexus:visualsources": sources },
    } as FullConfigType);
}

function seedBlock(blockId: string, meta: Record<string, unknown>) {
    // getWaveObjectAtom crea la entrada en el cache; setObjectValue la llena sin
    // tocar el backend (pushToServer=false).
    WOS.getWaveObjectAtom(WOS.makeORef("block", blockId));
    WOS.setObjectValue({ otype: "block", oid: blockId, version: 1, meta } as any, undefined, false);
}

function seedTab(blockIds: string[]) {
    const tabId = globalStore.get(atoms.staticTabId);
    WOS.getWaveObjectAtom(WOS.makeORef("tab", tabId));
    WOS.setObjectValue(
        { otype: "tab", oid: tabId, version: 1, name: "test", blockids: blockIds, layoutstate: "" } as any,
        undefined,
        false
    );
}

const bancoSource = {
    id: "hdmi-primary",
    type: "uvc",
    label: "Banco",
    device: { name: "USB Video", vid: "534d", pid: "2109" },
    aivision: "on_demand",
};

// Crear un WaveObject en el cache dispara un GetObject contra el backend, que en
// tests no existe (y deja una promesa colgada tras el teardown). Se corta ahi.
let getObjectSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-visual", windowId: "win-visual" } as GlobalInitOptions);
    getObjectSpy = vi.spyOn(ObjectService, "GetObject").mockImplementation(
        async (oref: string) => {
            const [otype, oid] = oref.split(":");
            return { otype, oid, version: 1, meta: {} } as WaveObj;
        }
    );
});

afterAll(() => {
    getObjectSpy?.mockRestore();
});

afterEach(() => {
    RpcApi.setMockRpcClient(null);
});

describe("catalogo de fuentes visuales en el contexto", () => {
    it("publica metadata y NUNCA imagen", () => {
        seedSettings([bancoSource]);
        seedTab([]);
        const ctx = captureVisualSources();
        expect(ctx.kind).toBe("visual_sources");
        const source = (ctx as any).sources[0];
        expect(source).toMatchObject({
            id: "hdmi-primary",
            label: "Banco",
            type: "uvc",
            ai_vision: "on_demand",
            visible: false,
            focused: false,
        });
        // el contrato del contexto es metadata: cualquier campo de imagen es un bug
        expect(JSON.stringify(ctx)).not.toMatch(/image|base64|frame/i);
    });

    it("marca visible y focused cuando hay un bloque HMI abierto", () => {
        seedSettings([bancoSource]);
        seedBlock("b-hmi", { view: "visual", "visual:source": "hdmi-primary" });
        seedTab(["b-hmi"]);

        const sinFoco = (captureVisualSources() as any).sources[0];
        expect(sinFoco.visible).toBe(true);
        expect(sinFoco.focused).toBe(false);

        const conFoco = (captureVisualSources("b-hmi") as any).sources[0];
        expect(conFoco.focused).toBe(true);
    });

    it("no afirma disponibilidad del dispositivo si el bloque no esta montado", () => {
        // El renderer no puede saber si la capturadora esta enchufada sin abrir
        // el stream. Inventarlo seria mentirle al cerebro.
        seedSettings([bancoSource]);
        seedBlock("b-hmi", { view: "visual", "visual:source": "hdmi-primary" });
        seedTab(["b-hmi"]);
        const source = (captureVisualSources() as any).sources[0];
        expect(source.available).toBeUndefined();
        expect(source.status).toBe("unknown");
    });

    it("sin fuentes configuradas no agrega ruido al contexto", () => {
        seedSettings([]);
        seedTab([]);
        expect(captureVisualSources().kind).toBe("empty");
    });

    it("respeta ai_vision off en el catalogo", () => {
        seedSettings([{ ...bancoSource, aivision: "off" }]);
        seedTab([]);
        expect((captureVisualSources() as any).sources[0].ai_vision).toBe("off");
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
