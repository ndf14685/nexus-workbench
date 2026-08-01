// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Verificación del cableado de la barra de widgets con el catálogo de IA
// (D-031/D-032): qué botones quedan visibles y qué pasa al hacer click en cada uno.

import { VendorWidgetKeyPrefix, mergeAiWidgets } from "@/app/nexus/ai-apps";
import { WidgetActionsMetaKey } from "@/app/nexus/widget-modes";
import { describe, expect, it } from "vitest";
import { handleWidgetSelect, type WidgetsEnv } from "./widgets";

// Estado de un usuario que ya tenía un botón por variante.
const LegacyWidgets = {
    "nexus-agent-codex": {
        label: "Codex",
        blockdef: { meta: { view: "term", controller: "cmd", cmd: "codex", "cmd:shell": true } },
    },
    "nexus-agent-codex-full": {
        label: "Codex con permisos completos",
        blockdef: { meta: { view: "term", controller: "cmd", cmd: "codex --yolo", "cmd:shell": true } },
    },
    "nexus-agent-claude": {
        label: "Claude",
        blockdef: { meta: { view: "term", controller: "cmd", cmd: "claude", "cmd:shell": true } },
    },
    "nexus-agent-claude-full": {
        label: "Claude con permisos completos",
        blockdef: {
            meta: {
                view: "term",
                controller: "cmd",
                cmd: "claude --dangerously-skip-permissions",
                "cmd:shell": true,
            },
        },
    },
    "nexus-link-chatgpt": {
        label: "ChatGPT",
        blockdef: { meta: { view: "web", url: "https://chatgpt.com/" } },
    },
    "nexus-env-rig": {
        label: "Rig Ubuntu",
        blockdef: { meta: { view: "term", controller: "shell", connection: "ndf@rig" } },
    },
} as unknown as Record<string, WidgetConfigType>;

function makeEnv() {
    const created: { blockdef: BlockDef; magnified?: boolean }[] = [];
    let menu: ContextMenuItem[] = null;
    const env = {
        createBlock: async (blockdef: BlockDef, magnified?: boolean) => {
            created.push({ blockdef, magnified });
            return "block-id";
        },
        showContextMenu: (items: ContextMenuItem[]) => {
            menu = items;
        },
    } as unknown as WidgetsEnv;
    return { env, created, getMenu: () => menu };
}

const clickEvent = {} as React.MouseEvent;

describe("barra de widgets con el catálogo de IA", () => {
    const widgets = mergeAiWidgets(LegacyWidgets);

    it("deja tres botones de IA, no seis", () => {
        const ai = Object.keys(widgets).filter((k) => k.startsWith(VendorWidgetKeyPrefix));
        expect(ai.sort()).toEqual([
            `${VendorWidgetKeyPrefix}anthropic`,
            `${VendorWidgetKeyPrefix}google`,
            `${VendorWidgetKeyPrefix}openai`,
        ]);
        expect(Object.keys(widgets).filter((k) => k.startsWith("nexus-agent-"))).toEqual([]);
        expect(widgets["nexus-link-chatgpt"]).toBeUndefined();
    });

    it("no toca los widgets de ambientes (terminales y SSH siguen igual)", () => {
        expect(widgets["nexus-env-rig"]).toEqual(LegacyWidgets["nexus-env-rig"]);
    });

    it("no agrega ningún acceso a Wave AI", () => {
        for (const w of Object.values(widgets)) {
            expect(w.blockdef?.meta?.["view"]).not.toBe("waveai");
        }
    });

    it("click en ChatGPT ofrece chat, Codex y Codex con permisos", async () => {
        const { env, created, getMenu } = makeEnv();
        await handleWidgetSelect(widgets[`${VendorWidgetKeyPrefix}openai`], env, clickEvent);
        expect(created).toEqual([]);
        const menu = getMenu();
        // encabezado + separador + chat + separador + 2 modos de CLI
        expect(menu.length).toBe(6);
        expect(menu[0].label).toBe("ChatGPT");
        expect(menu[0].enabled).toBe(false);
        expect(menu[2].label).toBe("ChatGPT (panel web)");
        expect(menu[4].label).toContain("Codex CLI");
        expect(menu[4].label).not.toContain("⚠");
        expect(menu[5].label).toContain("⚠");
    });

    it("click en Claude ofrece Claude Chat, Claude CLI y Claude CLI con permisos", async () => {
        const { env, getMenu } = makeEnv();
        await handleWidgetSelect(widgets[`${VendorWidgetKeyPrefix}anthropic`], env, clickEvent);
        const menu = getMenu();
        expect(menu.length).toBe(6);
        expect(menu[2].label).toBe("Claude Chat (panel web)");
        expect(menu[4].label).toContain("Claude CLI");
        expect(menu[5].label).toContain("⚠");
    });

    it("elegir el chat abre un panel web con su partición", async () => {
        const { env, created, getMenu } = makeEnv();
        await handleWidgetSelect(widgets[`${VendorWidgetKeyPrefix}openai`], env, clickEvent);
        getMenu()[2].click();
        const meta = created[0].blockdef.meta;
        expect(meta["view"]).toBe("web");
        expect(meta["url"]).toBe("https://chatgpt.com/");
        expect(meta["web:partition"]).toBe("persist:ai-chatgpt");
        expect(meta[WidgetActionsMetaKey]).toBeUndefined();
    });

    it("elegir el modo peligroso corre el comando real de bypass", async () => {
        const { env, created, getMenu } = makeEnv();
        await handleWidgetSelect(widgets[`${VendorWidgetKeyPrefix}anthropic`], env, clickEvent);
        getMenu()[5].click();
        const meta = created[0].blockdef.meta;
        expect(meta["cmd"]).toBe("claude --dangerously-skip-permissions");
        expect(meta["view"]).toBe("term");
        expect(meta["cmd:runonstart"]).toBe(true);
    });

    it("elegir el modo normal corre el comando sin flags", async () => {
        const { env, created, getMenu } = makeEnv();
        await handleWidgetSelect(widgets[`${VendorWidgetKeyPrefix}anthropic`], env, clickEvent);
        getMenu()[4].click();
        expect(created[0].blockdef.meta["cmd"]).toBe("claude");
    });

    it("click en Gemini ofrece Gemini chat, Agy CLI y Agy CLI con permisos", async () => {
        const { env, created, getMenu } = makeEnv();
        await handleWidgetSelect(widgets[`${VendorWidgetKeyPrefix}google`], env, clickEvent);
        const menu = getMenu();
        expect(menu.length).toBe(6);
        expect(menu[2].label).toBe("Gemini (panel web)");
        expect(menu[4].label).toContain("Agy CLI");
        expect(menu[5].label).toContain("⚠");
        menu[5].click();
        expect(created[0].blockdef.meta["cmd"]).toBe("agy --dangerously-skip-permissions");
    });

    it("dos aperturas del mismo chat comparten la sesión", async () => {
        const { env, created, getMenu } = makeEnv();
        await handleWidgetSelect(widgets[`${VendorWidgetKeyPrefix}anthropic`], env, clickEvent);
        getMenu()[2].click();
        getMenu()[2].click();
        expect(created.length).toBe(2);
        expect(created[0].blockdef.meta["web:partition"]).toBe(created[1].blockdef.meta["web:partition"]);
    });

    it("cada chat usa su propia partición", async () => {
        const { env, created, getMenu } = makeEnv();
        for (const id of ["openai", "anthropic", "google"]) {
            await handleWidgetSelect(widgets[VendorWidgetKeyPrefix + id], env, clickEvent);
            getMenu()[2].click();
        }
        expect(created.map((c) => c.blockdef.meta["web:partition"])).toEqual([
            "persist:ai-chatgpt",
            "persist:ai-claude",
            "persist:ai-gemini",
        ]);
    });
});
