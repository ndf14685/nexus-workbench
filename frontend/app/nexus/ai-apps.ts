// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Catálogo ÚNICO de las herramientas de IA del Workbench (D-031).
//
// Dos familias, deliberadamente separadas:
//
//   1. Agentes CLI  → corren DENTRO de una terminal (view "term", controller
//      "cmd"). Un botón por herramienta; las variantes de permisos son `modes`
//      del mismo botón (ver widget-modes.ts), nunca botones separados.
//   2. Chats web    → corren DENTRO de un módulo web embebido (view "web") con
//      una partición persistente POR PROVEEDOR, así el login sobrevive al
//      reinicio de la app sin guardar nunca una credencial en disco propio.
//
// Nada de URLs, nombres, iconos ni comandos hardcodeados fuera de este archivo.
// Para agregar un proveedor nuevo alcanza con sumar una entrada acá.

import {
    DangerLabelPrefix,
    NexusWidgetAction,
    NexusWidgetMode,
    WidgetActionsMetaKey,
    WidgetModesMetaKey,
} from "@/app/nexus/widget-modes";

// ---------------------------------------------------------------------------
// Particiones de sesión
// ---------------------------------------------------------------------------

// El prefijo "persist:" es lo que hace que Chromium escriba cookies/localStorage
// en disco (dentro del data dir de la app) en vez de tirarlos al cerrar. Un
// prefijo propio por familia permite al proceso main reconocer estas sesiones y
// aplicarles su política de permisos sin tocar el resto del navegador embebido.
export const AiPartitionPrefix = "persist:ai-";

export function aiPartition(id: string): string {
    return AiPartitionPrefix + id;
}

export function isAiPartition(partition: string): boolean {
    return typeof partition === "string" && partition.startsWith(AiPartitionPrefix);
}

// El user-agent de Electron lleva los tokens `waveterm/x` y `Electron/x`, y
// varios proveedores de identidad (Google el primero) rechazan por política el
// login desde algo que se declara "navegador embebido". Se quitan ESOS tokens y
// nada más: el resto —plataforma real y versión real de Chrome— queda intacto,
// así que no se está falseando el cliente, se está omitiendo el envoltorio.
export function chromeUserAgentFrom(userAgent: string): string {
    if (typeof userAgent !== "string" || userAgent === "") {
        return userAgent;
    }
    return userAgent
        .replace(/\s*(Electron|waveterm|nexus-workbench)\/[^\s]+/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// ---------------------------------------------------------------------------
// Agentes CLI (terminal)
// ---------------------------------------------------------------------------

export type NexusAiCliAgent = {
    id: string;
    label: string;
    icon: string;
    color: string;
    tooltip: string;
    // El primer modo es el default: es el `cmd` que queda en el blockdef para
    // cualquier consumidor que ignore los modos.
    modes: NexusWidgetMode[];
};

export const AI_CLI_AGENTS: NexusAiCliAgent[] = [
    {
        id: "codex",
        label: "Codex CLI",
        icon: "microchip",
        color: "#79c0ff",
        tooltip: "Abre Codex dentro de una terminal",
        modes: [
            { label: "Normal (pide aprobación)", command: "codex" },
            { label: "Permisos totales — bypass de aprobaciones", command: "codex --yolo", danger: true },
        ],
    },
    {
        id: "claude",
        label: "Claude CLI",
        icon: "robot",
        color: "#d2a8ff",
        tooltip: "Abre Claude Code dentro de una terminal",
        modes: [
            { label: "Normal (pide permisos)", command: "claude" },
            {
                label: "Permisos totales — bypass de permisos",
                command: "claude --dangerously-skip-permissions",
                danger: true,
            },
        ],
    },
    {
        id: "agy",
        label: "Agy CLI",
        icon: "gem",
        color: "#8ab4f8",
        tooltip: "Abre Agy (Antigravity CLI) dentro de una terminal",
        modes: [
            { label: "Normal (pide permisos)", command: "agy" },
            {
                label: "Permisos totales — bypass de permisos",
                command: "agy --dangerously-skip-permissions",
                danger: true,
            },
        ],
    },
];

// Flags que convierten a un modo en peligroso. Se usa para clasificar comandos
// que vienen del catálogo del usuario (widgets.json) y no del catálogo de acá.
const DangerFlagRe =
    /(^|\s)(--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo|--full-auto|--bypass-permissions|--permission-mode[= ]bypassPermissions)(\s|$)/;

export function isDangerCommand(command: string): boolean {
    return DangerFlagRe.test(command ?? "");
}

// ---------------------------------------------------------------------------
// Chats web (módulo web embebido)
// ---------------------------------------------------------------------------

export type NexusAiWebApp = {
    id: string;
    name: string;
    url: string;
    icon: string;
    color: string;
    tooltip: string;
};

// Antigravity NO está acá: es el IDE agéntico de Google (el lado de código de
// Gemini) y no tiene chat web. El chat de Gemini es gemini.google.com/app y ese
// es el que se embebe; su CLI —`agy`— entra como agente de terminal, no como
// chat web.
//
// Cualquier URL se cambia sin recompilar: redefinir la clave del widget
// (`nexus-ai-web-<id>`) en widgets.json —menú contextual de la barra →
// "Edit widgets.json"— pisa la entrada built-in.
export const AI_WEB_APPS: Record<string, NexusAiWebApp> = {
    chatgpt: {
        id: "chatgpt",
        name: "ChatGPT",
        url: "https://chatgpt.com/",
        icon: "comments",
        color: "#10a37f",
        tooltip: "Abre ChatGPT como panel web",
    },
    claude: {
        id: "claude",
        name: "Claude Chat",
        url: "https://claude.ai/new",
        icon: "comment-dots",
        color: "#d97757",
        tooltip: "Abre Claude Chat como panel web",
    },
    gemini: {
        id: "gemini",
        name: "Gemini",
        url: "https://gemini.google.com/app",
        icon: "gem",
        color: "#8ab4f8",
        tooltip: "Abre Gemini como panel web",
    },
};

// ---------------------------------------------------------------------------
// Proyección a bloques / widgets (reusa el sistema genérico, sin vistas nuevas)
// ---------------------------------------------------------------------------

export type OpenWebAppOpts = {
    id: string;
    title?: string;
    url: string;
    persistentPartition?: string;
};

// Abstracción genérica pedida por el diseño: cualquier proveedor se abre como
// un bloque "web" normal (mismo componente, mismo layout, mismo desacople).
// Cada instancia es un bloque distinto; la SESIÓN la comparten por partición.
export function webAppBlockDef(opts: OpenWebAppOpts): BlockDef {
    const meta: MetaType = {
        view: "web",
        url: opts.url,
        "web:partition": opts.persistentPartition ?? aiPartition(opts.id),
    };
    if (opts.title) {
        meta["frame:title"] = opts.title;
    }
    return { meta };
}

export function openWebApp(
    opts: OpenWebAppOpts,
    createBlock: (blockDef: BlockDef, magnified?: boolean, ephemeral?: boolean) => Promise<string>
): Promise<string> {
    return createBlock(webAppBlockDef(opts));
}

export function aiWebAppBlockDef(app: NexusAiWebApp): BlockDef {
    return webAppBlockDef({ id: app.id, title: app.name, url: app.url });
}

export function cliAgentBlockDef(agent: NexusAiCliAgent): BlockDef {
    const meta: MetaType = {
        view: "term",
        controller: "cmd",
        cmd: agent.modes[0].command,
        "cmd:shell": true,
        "cmd:runonstart": true,
    };
    meta[WidgetModesMetaKey] = agent.modes;
    return { meta };
}

// ---------------------------------------------------------------------------
// Proveedores: UN botón por proveedor, con sus superficies adentro (D-032)
// ---------------------------------------------------------------------------

// Un mismo proveedor tiene hoy dos superficies (chat web y CLI en terminal) y el
// CLI tiene dos modos de permisos. Como botones separados eso son 9 accesos para
// 3 proveedores. Acá es UN botón por proveedor y el click ofrece las superficies.
export type NexusAiVendor = {
    id: string;
    label: string;
    icon: string;
    color: string;
    tooltip: string;
    chat?: NexusAiWebApp;
    cli?: NexusAiCliAgent;
};

export const AI_VENDORS: NexusAiVendor[] = [
    {
        id: "openai",
        label: "ChatGPT",
        icon: "comments",
        color: "#10a37f",
        tooltip: "ChatGPT como panel web · Codex CLI en una terminal",
        chat: AI_WEB_APPS.chatgpt,
        cli: AI_CLI_AGENTS.find((a) => a.id === "codex"),
    },
    {
        id: "anthropic",
        label: "Claude",
        icon: "robot",
        color: "#d97757",
        tooltip: "Claude Chat como panel web · Claude Code en una terminal",
        chat: AI_WEB_APPS.claude,
        cli: AI_CLI_AGENTS.find((a) => a.id === "claude"),
    },
    {
        id: "google",
        label: "Gemini",
        icon: "gem",
        color: "#8ab4f8",
        tooltip: "Gemini como panel web · Agy (Antigravity CLI) en una terminal",
        chat: AI_WEB_APPS.gemini,
        cli: AI_CLI_AGENTS.find((a) => a.id === "agy"),
    },
];

export const VendorWidgetKeyPrefix = "nexus-ai-";

// El grupo de IA queda junto, después de los widgets base de la app
// (terminal -5, files -4, jarvis -3) y antes de lo que genera el importador.
const VendorOrderBase = -2.9;

export function vendorActions(vendor: NexusAiVendor): NexusWidgetAction[] {
    const actions: NexusWidgetAction[] = [];
    if (vendor.chat != null) {
        actions.push({ label: `${vendor.chat.name} (panel web)`, meta: aiWebAppBlockDef(vendor.chat).meta });
    }
    if (vendor.cli != null) {
        vendor.cli.modes.forEach((mode, idx) => {
            const meta = { ...cliAgentBlockDef(vendor.cli).meta };
            meta["cmd"] = mode.command;
            delete meta[WidgetModesMetaKey];
            actions.push({
                label: `${vendor.cli.label} — ${mode.label}`,
                meta,
                ...(mode.danger ? { danger: true as const } : {}),
                ...(idx === 0 ? { separatorBefore: true as const } : {}),
            });
        });
    }
    return actions;
}

export function vendorBlockDef(vendor: NexusAiVendor): BlockDef {
    const actions = vendorActions(vendor);
    // El blockdef base es la primera acción: si alguien ignora el menú (o el
    // proveedor tiene una sola superficie), el click abre eso directamente.
    const meta = { ...actions[0].meta };
    if (actions.length > 1) {
        meta[WidgetActionsMetaKey] = actions;
    }
    return { meta };
}

export function builtinAiWidgets(): Record<string, WidgetConfigType> {
    const rtn: Record<string, WidgetConfigType> = {};
    AI_VENDORS.forEach((vendor, idx) => {
        rtn[VendorWidgetKeyPrefix + vendor.id] = {
            "display:order": VendorOrderBase + idx * 0.1,
            icon: vendor.icon,
            color: vendor.color,
            label: vendor.label,
            description: vendor.tooltip,
            blockdef: vendorBlockDef(vendor),
        };
    });
    return rtn;
}

// ---------------------------------------------------------------------------
// Fusión con el catálogo del usuario (widgets.json)
// ---------------------------------------------------------------------------

type Token = { value: string; quoted: boolean; index: number };

function tokenize(cmd: string): Token[] {
    const rtn: Token[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray;
    while ((m = re.exec(cmd)) != null) {
        rtn.push({ value: m[1] ?? m[2] ?? m[3], quoted: m[1] != null || m[2] != null, index: m.index });
    }
    return rtn;
}

function toolName(token: string): string {
    const base = token.split(/[/\\]/).pop() ?? token;
    return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

// Envoltorios que no son la herramienta: lo que importa está adentro.
const ShellWrappers = new Set(["bash", "sh", "zsh", "fish", "dash", "cmd", "powershell", "pwsh", "wsl", "ssh", "sudo"]);
// Flags de envoltorio que consumen el argumento siguiente (wsl -d Ubuntu, sudo -u x).
const WrapperFlagsWithValue = /^(-d|--distribution|-u|--user|-e|--exec|-i|--identity|-p|--port)$/i;

/**
 * Desenvuelve una invocación hasta la herramienta real:
 *
 *   `FOO=1 env wsl -d Ubuntu -- bash -lc "claude --resume"`  →  `claude --resume`
 *
 * Sin esto, un widget heredado que lanza el CLI a través de wsl o de una shell
 * no se reconocía como el mismo agente y quedaba como un botón extra.
 */
export function unwrapInvocation(cmd: string, depth = 0): string {
    const stripped = String(cmd ?? "")
        .trim()
        .replace(/^env\s+/, "")
        .replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, "");
    if (depth >= 4 || stripped === "") {
        return stripped;
    }
    const tokens = tokenize(stripped);
    if (tokens.length === 0 || tokens[0].quoted || !ShellWrappers.has(toolName(tokens[0].value))) {
        return stripped;
    }
    const isCmdExe = toolName(tokens[0].value) === "cmd";
    let i = 1;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.quoted) {
            break;
        }
        if (token.value === "--") {
            i++;
            break;
        }
        if (!token.value.startsWith("-") && !(isCmdExe && token.value.startsWith("/"))) {
            break;
        }
        if (WrapperFlagsWithValue.test(token.value)) {
            i++;
        }
        i++;
    }
    if (i >= tokens.length) {
        return stripped;
    }
    const rest = tokens[i].quoted ? tokens[i].value : stripped.slice(tokens[i].index);
    return unwrapInvocation(rest, depth + 1);
}

/**
 * Herramienta que lanza un widget de terminal: "claude --dangerously-skip-permissions"
 * → "claude"; "wsl -d Ubuntu -- codex --yolo" → "codex". null si el widget no
 * lanza un comando (una terminal pelada, un bloque web, etc.).
 */
export function widgetBaseCommand(blockdef: BlockDef): string | null {
    const meta = blockdef?.meta;
    if (meta == null || meta["view"] !== "term" || meta["controller"] !== "cmd") {
        return null;
    }
    const cmd = meta["cmd"];
    if (typeof cmd !== "string" || cmd.trim() === "") {
        return null;
    }
    const unwrapped = unwrapInvocation(cmd);
    const first = tokenize(unwrapped)[0];
    if (first == null) {
        return null;
    }
    return toolName(first.value);
}

function sameOrigin(a: string, b: string): boolean {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

function widgetWebUrl(blockdef: BlockDef): string | null {
    const meta = blockdef?.meta;
    if (meta == null || meta["view"] !== "web" || typeof meta["url"] !== "string") {
        return null;
    }
    return meta["url"];
}

/**
 * Devuelve el mapa de widgets que la barra debe mostrar: el del usuario más los
 * built-in de IA, sin duplicados.
 *
 * Reglas (en este orden):
 *
 *  - Un widget del usuario con la MISMA CLAVE que un built-in gana: así se
 *    personaliza una URL o un comando sin recompilar.
 *  - Un widget LOCAL que lanza el CLI de un proveedor (claude, codex, agy —
 *    también vía wsl/bash/env) se PLIEGA dentro del botón de ese proveedor. Si
 *    la invocación no es ninguna de las conocidas, se conserva como acción
 *    extra en el mismo menú.
 *  - Un widget web que abre el mismo origen que el chat de un proveedor también
 *    se pliega (típicamente un `nexus-link-*` del importador).
 *  - Un widget con `connection` NO se pliega: un agente en un ambiente remoto es
 *    otra herramienta, no una variante de la local.
 */
export function mergeAiWidgets(configWidgets: Record<string, WidgetConfigType>): Record<string, WidgetConfigType> {
    const widgets = { ...(configWidgets ?? {}) };
    const builtins = builtinAiWidgets();
    const extraActions = new Map<string, NexusWidgetAction[]>();

    const vendorForCommand = (base: string) => AI_VENDORS.find((v) => v.cli?.id === base);
    const vendorForUrl = (url: string) => AI_VENDORS.find((v) => v.chat != null && sameOrigin(v.chat.url, url));

    for (const [key, widget] of Object.entries(widgets)) {
        if (builtins[key] != null || widget?.blockdef?.meta?.["connection"]) {
            continue;
        }
        const url = widgetWebUrl(widget?.blockdef);
        if (url != null) {
            if (vendorForUrl(url) != null) {
                delete widgets[key];
            }
            continue;
        }
        const base = widgetBaseCommand(widget?.blockdef);
        const vendor = base != null ? vendorForCommand(base) : null;
        if (vendor == null) {
            continue;
        }
        const known = new Set(vendor.cli.modes.map((m) => m.command.trim()));
        const declared: NexusWidgetMode[] = Array.isArray(widget.blockdef.meta[WidgetModesMetaKey])
            ? (widget.blockdef.meta[WidgetModesMetaKey] as NexusWidgetMode[])
            : [
                  {
                      label: widget.label ?? String(widget.blockdef.meta["cmd"]),
                      command: String(widget.blockdef.meta["cmd"]),
                  },
              ];
        for (const mode of declared) {
            const command = String(mode?.command ?? "").trim();
            if (command === "" || known.has(command)) {
                continue;
            }
            known.add(command);
            const meta = { ...widget.blockdef.meta };
            meta["cmd"] = command;
            delete meta[WidgetModesMetaKey];
            const list = extraActions.get(vendor.id) ?? [];
            list.push({
                label: `${vendor.cli.label} — ${mode.label ?? command}`,
                meta,
                ...(mode.danger === true || isDangerCommand(command) ? { danger: true as const } : {}),
            });
            extraActions.set(vendor.id, list);
        }
        delete widgets[key];
    }

    for (const [key, builtin] of Object.entries(builtins)) {
        if (widgets[key] != null) {
            continue;
        }
        const extras = extraActions.get(key.slice(VendorWidgetKeyPrefix.length));
        if (extras == null || extras.length === 0) {
            widgets[key] = builtin;
            continue;
        }
        const meta = { ...builtin.blockdef.meta };
        const base = Array.isArray(meta[WidgetActionsMetaKey])
            ? (meta[WidgetActionsMetaKey] as NexusWidgetAction[])
            : [{ label: builtin.label, meta: builtin.blockdef.meta }];
        meta[WidgetActionsMetaKey] = [...base, ...extras];
        widgets[key] = { ...builtin, blockdef: { meta } };
    }
    return widgets;
}

// Reexport para que los consumidores de la barra no tengan que conocer
// widget-modes.ts solo por el prefijo de peligro.
export { DangerLabelPrefix };
