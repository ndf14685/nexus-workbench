// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    AI_CLI_AGENTS,
    AI_VENDORS,
    AI_WEB_APPS,
    VendorWidgetKeyPrefix,
    aiPartition,
    aiWebAppBlockDef,
    builtinAiWidgets,
    chromeUserAgentFrom,
    cliAgentBlockDef,
    isAiPartition,
    isDangerCommand,
    mergeAiWidgets,
    openWebApp,
    unwrapInvocation,
    vendorActions,
    vendorBlockDef,
    webAppBlockDef,
    widgetBaseCommand,
} from "./ai-apps";
import { buildActionMenuItems, parseWidgetActions, parseWidgetModes } from "./widget-modes";

function termWidget(cmd: string, extra: Record<string, any> = {}): WidgetConfigType {
    return {
        label: cmd,
        blockdef: { meta: { view: "term", controller: "cmd", cmd, "cmd:shell": true, ...extra } },
    } as WidgetConfigType;
}

function webWidget(url: string): WidgetConfigType {
    return { label: url, blockdef: { meta: { view: "web", url } } } as WidgetConfigType;
}

describe("catálogo de proveedores", () => {
    it("son tres botones: ChatGPT, Claude y Gemini", () => {
        expect(AI_VENDORS.map((v) => v.label)).toEqual(["ChatGPT", "Claude", "Gemini"]);
    });

    it("los tres traen chat web + CLI propio", () => {
        const byId = new Map(AI_VENDORS.map((v) => [v.id, v]));
        expect(byId.get("openai").chat.name).toBe("ChatGPT");
        expect(byId.get("openai").cli.id).toBe("codex");
        expect(byId.get("anthropic").chat.name).toBe("Claude Chat");
        expect(byId.get("anthropic").cli.id).toBe("claude");
        expect(byId.get("google").chat.name).toBe("Gemini");
        expect(byId.get("google").cli.id).toBe("agy");
    });

    it("ningún proveedor comparte CLI ni chat con otro (sin accesos duplicados)", () => {
        const cliIds = AI_VENDORS.map((v) => v.cli.id);
        const chatIds = AI_VENDORS.map((v) => v.chat.id);
        expect(new Set(cliIds).size).toBe(cliIds.length);
        expect(new Set(chatIds).size).toBe(chatIds.length);
    });

    it("declara los tres chats web y NO declara antigravity", () => {
        expect(Object.keys(AI_WEB_APPS).sort()).toEqual(["chatgpt", "claude", "gemini"]);
        expect(Object.keys(AI_WEB_APPS)).not.toContain("antigravity");
    });

    it("cada agente CLI tiene un modo normal y uno peligroso, en ese orden", () => {
        for (const agent of AI_CLI_AGENTS) {
            expect(agent.modes.length).toBe(2);
            expect(agent.modes[0].danger).toBeUndefined();
            expect(agent.modes[1].danger).toBe(true);
            expect(isDangerCommand(agent.modes[1].command)).toBe(true);
            expect(isDangerCommand(agent.modes[0].command)).toBe(false);
        }
    });

    it("todo chat web tiene url https y datos de presentación completos", () => {
        for (const app of Object.values(AI_WEB_APPS)) {
            expect(app.url.startsWith("https://")).toBe(true);
            expect(app.name).toBeTruthy();
            expect(app.icon).toBeTruthy();
            expect(app.tooltip).toBeTruthy();
        }
    });
});

describe("acciones de un proveedor", () => {
    const openai = AI_VENDORS.find((v) => v.id === "openai");
    const google = AI_VENDORS.find((v) => v.id === "google");

    it("ChatGPT ofrece chat + Codex normal + Codex con permisos", () => {
        const actions = vendorActions(openai);
        expect(actions.map((a) => a.label)).toEqual([
            "ChatGPT (panel web)",
            "Codex CLI — Normal (pide aprobación)",
            "Codex CLI — Permisos totales — bypass de aprobaciones",
        ]);
        expect(actions[0].meta["view"]).toBe("web");
        expect(actions[1].meta["cmd"]).toBe("codex");
        expect(actions[2].meta["cmd"]).toBe("codex --yolo");
        expect(actions[2].danger).toBe(true);
    });

    it("Claude ofrece chat + CLI normal + CLI con permisos", () => {
        const actions = vendorActions(AI_VENDORS.find((v) => v.id === "anthropic"));
        expect(actions.length).toBe(3);
        expect(actions[0].meta["web:partition"]).toBe("persist:ai-claude");
        expect(actions[1].meta["cmd"]).toBe("claude");
        expect(actions[2].meta["cmd"]).toBe("claude --dangerously-skip-permissions");
        expect(actions[2].danger).toBe(true);
    });

    it("Gemini ofrece chat + Agy normal + Agy con permisos", () => {
        const actions = vendorActions(google);
        expect(actions.map((a) => a.label)).toEqual([
            "Gemini (panel web)",
            "Agy CLI — Normal (pide permisos)",
            "Agy CLI — Permisos totales — bypass de permisos",
        ]);
        expect(actions[0].meta["url"]).toBe(AI_WEB_APPS.gemini.url);
        expect(actions[1].meta["cmd"]).toBe("agy");
        expect(actions[2].meta["cmd"]).toBe("agy --dangerously-skip-permissions");
        expect(actions[2].danger).toBe(true);
    });

    it("el click de cualquier proveedor abre el menú, nunca un bloque suelto", () => {
        for (const vendor of AI_VENDORS) {
            expect(vendorActions(vendor).length).toBe(3);
            expect(buildActionMenuItems(vendorBlockDef(vendor), () => {}).length).toBe(4);
        }
    });

    it("el menú separa el chat del CLI y marca el modo peligroso", () => {
        const items = buildActionMenuItems(vendorBlockDef(openai), () => {}, { title: "ChatGPT" });
        // encabezado + separador + chat + separador + 2 modos de CLI
        expect(items.length).toBe(6);
        expect(items[0].enabled).toBe(false);
        expect(items[2].label).toContain("panel web");
        expect(items[3].type).toBe("separator");
        expect(items[4].label).not.toContain("⚠");
        expect(items[5].label).toContain("⚠");
    });

    it("elegir una acción abre el bloque de esa superficie y no arrastra el menú", () => {
        const opened: BlockDef[] = [];
        // sin título: [chat, separador, CLI normal, ⚠ CLI permisos totales]
        const items = buildActionMenuItems(vendorBlockDef(openai), (bd) => opened.push(bd));
        items[2].click();
        expect(opened[0].meta["view"]).toBe("term");
        expect(opened[0].meta["cmd"]).toBe("codex");
        expect(opened[0].meta["cmd:runonstart"]).toBe(true);
        expect(parseWidgetActions(opened[0]).length).toBe(0);
    });
});

describe("particiones persistentes", () => {
    it("una partición por proveedor, con prefijo persistente", () => {
        expect(aiPartition("chatgpt")).toBe("persist:ai-chatgpt");
        expect(isAiPartition("persist:ai-chatgpt")).toBe(true);
        expect(isAiPartition("persist:otracosa")).toBe(false);
        expect(isAiPartition(undefined as unknown as string)).toBe(false);
    });

    it("cada chat web abre con SU partición y ninguna se repite", () => {
        const partitions = Object.values(AI_WEB_APPS).map((a) => aiWebAppBlockDef(a).meta["web:partition"]);
        expect(new Set(partitions).size).toBe(partitions.length);
        for (const p of partitions) {
            expect(isAiPartition(p as string)).toBe(true);
        }
    });

    it("openWebApp reusa el bloque web genérico (sin vista propia por proveedor)", async () => {
        const created: BlockDef[] = [];
        await openWebApp({ id: "chatgpt", title: "ChatGPT", url: AI_WEB_APPS.chatgpt.url }, async (bd) => {
            created.push(bd);
            return "blk";
        });
        expect(created[0].meta["view"]).toBe("web");
        expect(created[0].meta["web:partition"]).toBe("persist:ai-chatgpt");
    });

    it("dos instancias del mismo proveedor comparten sesión", () => {
        const a = webAppBlockDef({ id: "claude", url: AI_WEB_APPS.claude.url });
        const b = webAppBlockDef({ id: "claude", url: AI_WEB_APPS.claude.url });
        expect(a.meta["web:partition"]).toBe(b.meta["web:partition"]);
    });

    it("los chats web no piden nada del sistema local: solo view/url/partición", () => {
        for (const app of Object.values(AI_WEB_APPS)) {
            const meta = aiWebAppBlockDef(app).meta;
            expect(meta["controller"]).toBeUndefined();
            expect(meta["connection"]).toBeUndefined();
            expect(meta["cmd"]).toBeUndefined();
        }
    });
});

describe("user-agent de los paneles de IA", () => {
    const electronUa =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) waveterm/0.15.0-beta.9 Chrome/146.0.0.0 Electron/41.1.0 Safari/537.36";

    it("saca los tokens del envoltorio y conserva plataforma y Chrome reales", () => {
        const ua = chromeUserAgentFrom(electronUa);
        expect(ua).not.toContain("Electron/");
        expect(ua).not.toContain("waveterm/");
        expect(ua).toContain("Windows NT 10.0; Win64; x64");
        expect(ua).toContain("Chrome/146.0.0.0");
        expect(ua).not.toContain("  ");
    });

    it("un user-agent que ya es de Chrome queda igual", () => {
        const chrome =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
        expect(chromeUserAgentFrom(chrome)).toBe(chrome);
    });

    it("no explota con entradas vacías", () => {
        expect(chromeUserAgentFrom("")).toBe("");
        expect(chromeUserAgentFrom(null as unknown as string)).toBeNull();
    });
});

describe("blockdef de los agentes CLI", () => {
    it("abre una terminal que corre el comando real del modo por defecto", () => {
        const bd = cliAgentBlockDef(AI_CLI_AGENTS[0]);
        expect(bd.meta["view"]).toBe("term");
        expect(bd.meta["controller"]).toBe("cmd");
        expect(bd.meta["cmd"]).toBe("codex");
        expect(bd.meta["cmd:runonstart"]).toBe(true);
        expect(parseWidgetModes(bd).length).toBe(2);
    });
});

describe("unwrapInvocation", () => {
    it("atraviesa variables de entorno, wsl, shells y comillas", () => {
        expect(unwrapInvocation("claude")).toBe("claude");
        expect(unwrapInvocation("  FOO=1 BAR='x y' claude --resume ")).toBe("claude --resume");
        expect(unwrapInvocation("env claude")).toBe("claude");
        expect(unwrapInvocation("wsl -d Ubuntu -- codex --yolo")).toBe("codex --yolo");
        expect(unwrapInvocation('bash -lc "claude --dangerously-skip-permissions"')).toBe(
            "claude --dangerously-skip-permissions"
        );
        expect(unwrapInvocation("cmd /c codex")).toBe("codex");
        expect(unwrapInvocation('wsl -d Ubuntu -- bash -lc "FOO=1 claude"')).toBe("claude");
    });

    it("no se cuelga ni inventa herramientas", () => {
        expect(unwrapInvocation("")).toBe("");
        expect(unwrapInvocation(null as unknown as string)).toBe("");
        expect(unwrapInvocation("wsl")).toBe("wsl");
        expect(unwrapInvocation("bash")).toBe("bash");
        expect(unwrapInvocation("bash -lc \"bash -lc 'bash -lc x'\"")).toBeTruthy();
    });
});

describe("widgetBaseCommand", () => {
    it("reduce una invocación a la herramienta", () => {
        expect(widgetBaseCommand(termWidget("claude --dangerously-skip-permissions").blockdef)).toBe("claude");
        expect(widgetBaseCommand(termWidget("/usr/local/bin/codex --yolo").blockdef)).toBe("codex");
        expect(widgetBaseCommand(termWidget("C:\\tools\\codex.exe").blockdef)).toBe("codex");
        expect(widgetBaseCommand(termWidget("wsl -d Ubuntu -- claude").blockdef)).toBe("claude");
    });

    it("ignora lo que no es un comando de terminal", () => {
        expect(widgetBaseCommand({ meta: { view: "web", url: "https://x" } })).toBeNull();
        expect(widgetBaseCommand({ meta: { view: "term", controller: "shell" } })).toBeNull();
        expect(widgetBaseCommand(null as unknown as BlockDef)).toBeNull();
    });
});

describe("mergeAiWidgets", () => {
    it("agrega exactamente tres botones cuando el usuario no tiene nada", () => {
        expect(Object.keys(mergeAiWidgets({})).sort()).toEqual([
            `${VendorWidgetKeyPrefix}anthropic`,
            `${VendorWidgetKeyPrefix}google`,
            `${VendorWidgetKeyPrefix}openai`,
        ]);
    });

    it("los cuatro botones heredados quedan en dos (uno por proveedor)", () => {
        const legacy = {
            "nexus-agent-claude": termWidget("claude"),
            "nexus-agent-claude-full": termWidget("claude --dangerously-skip-permissions"),
            "nexus-agent-codex": termWidget("codex"),
            "nexus-agent-codex-full": termWidget("codex --yolo"),
            "nexus-agent-agy": termWidget("agy"),
            "nexus-agent-agy-full": termWidget("agy --dangerously-skip-permissions"),
        };
        const rtn = mergeAiWidgets(legacy);
        expect(Object.keys(rtn).filter((k) => k.startsWith("nexus-agent-"))).toEqual([]);
        expect(Object.keys(rtn).length).toBe(3);
        for (const id of ["openai", "anthropic", "google"]) {
            expect(parseWidgetActions(rtn[VendorWidgetKeyPrefix + id].blockdef).length).toBe(3);
        }
    });

    it("pliega también las invocaciones envueltas (wsl, bash -lc, env)", () => {
        const rtn = mergeAiWidgets({
            "nexus-cmd-a": termWidget("wsl -d Ubuntu -- claude"),
            "nexus-cmd-b": termWidget('bash -lc "codex --yolo"'),
            "nexus-cmd-c": termWidget("FOO=1 claude"),
        });
        expect(Object.keys(rtn).length).toBe(3);
        expect(Object.keys(rtn).every((k) => k.startsWith(VendorWidgetKeyPrefix))).toBe(true);
    });

    it("pliega un link web al mismo proveedor", () => {
        const rtn = mergeAiWidgets({
            "nexus-link-chatgpt": webWidget("https://chatgpt.com/c/123"),
            "nexus-link-gemini": webWidget("https://gemini.google.com/app"),
        });
        expect(Object.keys(rtn).length).toBe(3);
        expect(rtn["nexus-link-chatgpt"]).toBeUndefined();
        expect(rtn["nexus-link-gemini"]).toBeUndefined();
    });

    it("conserva como acción extra una invocación que no está en el catálogo", () => {
        const rtn = mergeAiWidgets({ "nexus-cmd-resume": termWidget("claude --resume") });
        const actions = parseWidgetActions(rtn[`${VendorWidgetKeyPrefix}anthropic`].blockdef);
        expect(actions.length).toBe(4);
        expect(actions.some((a) => a.meta["cmd"] === "claude --resume")).toBe(true);
    });

    it("marca peligrosa una acción extra con flag de bypass", () => {
        const rtn = mergeAiWidgets({ "nexus-cmd-x": termWidget("codex --full-auto") });
        const extra = parseWidgetActions(rtn[`${VendorWidgetKeyPrefix}openai`].blockdef).find(
            (a) => a.meta["cmd"] === "codex --full-auto"
        );
        expect(extra?.danger).toBe(true);
    });

    it("NO pliega un agente remoto: es otra herramienta, no una variante", () => {
        const rtn = mergeAiWidgets({ "nexus-agent-claude-rig": termWidget("claude", { connection: "ndf@rig" }) });
        expect(rtn["nexus-agent-claude-rig"]).toBeDefined();
        expect(rtn[`${VendorWidgetKeyPrefix}anthropic`]).toBeDefined();
    });

    it("no toca widgets ajenos (terminales, ssh, comandos)", () => {
        const others = {
            "nexus-env-rig": { blockdef: { meta: { view: "term", controller: "shell", connection: "ndf@rig" } } },
            "defwidget@files": { blockdef: { meta: { view: "preview", file: "~" } } },
            "nexus-cmd-htop": termWidget("htop"),
            "nexus-link-repo": webWidget("https://github.com/ndf14685"),
        } as unknown as Record<string, WidgetConfigType>;
        const rtn = mergeAiWidgets(others);
        for (const key of Object.keys(others)) {
            expect(rtn[key]).toEqual(others[key]);
        }
    });

    it("una clave built-in redefinida por el usuario gana", () => {
        const custom = {
            [`${VendorWidgetKeyPrefix}google`]: {
                label: "Gemini",
                blockdef: { meta: { view: "web", url: "https://otra.url/", "web:partition": "persist:ai-gemini" } },
            },
        } as unknown as Record<string, WidgetConfigType>;
        expect(mergeAiWidgets(custom)[`${VendorWidgetKeyPrefix}google`].blockdef.meta["url"]).toBe("https://otra.url/");
    });

    it("es idempotente: fusionar dos veces no duplica ni pierde nada", () => {
        const once = mergeAiWidgets({ "nexus-agent-claude": termWidget("claude") });
        expect(mergeAiWidgets(once)).toEqual(once);
    });

    it("no muta el mapa de entrada", () => {
        const input = { "nexus-agent-claude": termWidget("claude") };
        const copy = JSON.parse(JSON.stringify(input));
        mergeAiWidgets(input);
        expect(input).toEqual(copy);
    });
});

describe("builtinAiWidgets", () => {
    it("cada widget trae icono, color y tooltip explicativo", () => {
        for (const w of Object.values(builtinAiWidgets())) {
            expect(w.icon).toBeTruthy();
            expect(w.color).toBeTruthy();
            expect(w.description).toBeTruthy();
        }
    });

    it("los tres van juntos y en orden estable", () => {
        const orders = Object.values(builtinAiWidgets()).map((w) => w["display:order"]);
        expect(new Set(orders).size).toBe(orders.length);
        expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    });
});
