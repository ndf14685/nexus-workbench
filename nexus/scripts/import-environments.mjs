#!/usr/bin/env node
// Nexus Workbench — importa nexus/config/environments.yaml a la config nativa de Wave.
//
// Uso:  node nexus/scripts/import-environments.mjs [ruta.yaml] [--dev] [--dry-run]
//
// - Escribe entradas en <configDir>/connections.json (ssh y wsl) con term:theme
//   por clase de ambiente, y presets de fondo de tab en <configDir>/presets.json.
// - Merge NO destructivo: preserva claves existentes; solo crea/actualiza las
//   claves gestionadas. Hace backup timestampeado antes de escribir.
// - No maneja credenciales: los hosts deben resolverse vía ~/.ssh/config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// El catálogo puede ser .json (sin dependencias) o .yaml (requiere el paquete
// "yaml": npm install yaml --no-save --ignore-scripts --workspaces=false).
function parseCatalogFile(p) {
    const raw = fs.readFileSync(p, "utf8");
    if (p.endsWith(".json")) {
        return { raw, parsed: JSON.parse(raw) };
    }
    let YAML;
    try {
        const require = createRequire(new URL("../../package.json", import.meta.url));
        YAML = require("yaml");
    } catch {
        console.error("Falta el paquete 'yaml'. Opciones:");
        console.error("  npm install yaml --no-save --ignore-scripts --workspaces=false");
        console.error("  ...o usá un catálogo .json (environments.json) que no necesita nada.");
        process.exit(1);
    }
    return { raw, parsed: YAML.parse(raw) };
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const isDev = args.includes("--dev");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultYaml = path.join(scriptDir, "..", "config", "environments.yaml");
const defaultJson = path.join(scriptDir, "..", "config", "environments.json");
// preferimos .json: no requiere dependencias (el .yaml necesita el paquete "yaml")
const yamlPath =
    args.find((a) => !a.startsWith("--")) ?? (fs.existsSync(defaultJson) ? defaultJson : defaultYaml);

const ClassThemes = {
    lab: "dracula",
    personal: "default-dark",
    work: "campbell",
    prod: "warmyellow",
};

const ClassBackgrounds = {
    lab: { color: "purple", opacity: 0.15 },
    personal: { color: "green", opacity: 0.1 },
    work: { color: "blue", opacity: 0.2 },
    prod: { color: "red", opacity: 0.25 },
};

function getConfigDir() {
    if (process.env.WAVETERM_CONFIG_HOME) {
        return process.env.WAVETERM_CONFIG_HOME;
    }
    const dirName = isDev ? "waveterm-dev" : "waveterm";
    if (process.env.XDG_CONFIG_HOME) {
        return path.join(process.env.XDG_CONFIG_HOME, dirName);
    }
    return path.join(os.homedir(), ".config", dirName);
}

function readJson(p) {
    if (!fs.existsSync(p)) {
        return {};
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function backupAndWrite(p, data) {
    if (dryRun) {
        console.log(`[dry-run] escribiría ${p}:`);
        console.log(JSON.stringify(data, null, 4));
        return;
    }
    if (fs.existsSync(p)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(p, `${p}.bak-${stamp}`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 4) + "\n");
    console.log(`actualizado: ${p}`);
}

if (!fs.existsSync(yamlPath)) {
    console.error(`No existe ${yamlPath}.`);
    console.error("Copiá nexus/config/environments.example.yaml a nexus/config/environments.yaml (o .json) y editalo.");
    process.exit(1);
}

const { raw, parsed: catalog } = parseCatalogFile(yamlPath);
if (catalog?.version !== 1 || !Array.isArray(catalog.environments)) {
    console.error("Formato inválido: se espera { version: 1, environments: [...] }");
    process.exit(1);
}

const forbidden = /password|passphrase|token|secret|private[_-]?key|BEGIN (RSA|OPENSSH)/i;
const rawSansComments = raw
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");
if (forbidden.test(rawSansComments)) {
    console.error("ABORTADO: el catálogo parece contener material sensible (password/token/clave).");
    process.exit(2);
}

const configDir = getConfigDir();
const connPath = path.join(configDir, "connections.json");
const presetsPath = path.join(configDir, "presets.json");

const connections = readJson(connPath);
let connChanges = 0;
for (const env of catalog.environments) {
    if (env.kind !== "ssh" && env.kind !== "wsl") {
        continue;
    }
    const key = env.kind === "wsl" ? `wsl://${env.distro}` : env.host;
    if (!key) {
        console.warn(`omitido ${env.id}: falta ${env.kind === "wsl" ? "distro" : "host"}`);
        continue;
    }
    const theme = env.theme ?? ClassThemes[env.class] ?? "default-dark";
    connections[key] = {
        ...connections[key],
        "display:order": catalog.environments.indexOf(env),
        "term:theme": theme,
    };
    connChanges++;
}

const presets = readJson(presetsPath);
for (const [cls, bg] of Object.entries(ClassBackgrounds)) {
    presets[`bg@nexus-${cls}`] = {
        "display:name": `Nexus: ${cls}`,
        "display:order": 10,
        bg: bg.color,
        "bg:opacity": bg.opacity,
    };
}

// Barra de widgets: un botón por ambiente (estilo lista de conexiones de
// WinSSHterm). Click => abre una terminal en esa conexión. Se gestionan solo
// las claves con prefijo nexus-env-; el resto de widgets.json se preserva.
const ClassColors = {
    lab: "#a371f7",
    personal: "#3fb950",
    work: "#58a6ff",
    prod: "#f85149",
};
const KindIcons = { local: "desktop", wsl: "layer-group", ssh: "server" };

const widgetsPath = path.join(configDir, "widgets.json");
const widgets = readJson(widgetsPath);
for (const key of Object.keys(widgets)) {
    if (key.startsWith("nexus-env-") || key.startsWith("nexus-agent-")) {
        delete widgets[key];
    }
}
let widgetCount = 0;
for (const env of catalog.environments) {
    const meta = { view: "term", controller: "shell" };
    if (env.kind === "ssh" || env.kind === "wsl") {
        const conn = env.kind === "wsl" ? `wsl://${env.distro}` : env.host;
        if (!conn) {
            continue;
        }
        meta.connection = conn;
    }
    widgets[`nexus-env-${env.id}`] = {
        "display:order": 100 + widgetCount,
        icon: env.icon ?? KindIcons[env.kind] ?? "server",
        color: ClassColors[env.class] ?? "#8b949e",
        label: env.name ?? env.id,
        description: `${env.kind}${meta.connection ? " " + meta.connection : ""} (${env.class ?? "?"})`,
        blockdef: { meta },
    };
    widgetCount++;
}

// Agentes de IA por suscripción (Claude Code, Codex, etc.): widgets que lanzan
// el CLI en un bloque terminal. El OAuth/login lo maneja el propio CLI.
let agentCount = 0;
for (const agent of catalog.agents ?? []) {
    if (!agent.id || !agent.command) {
        console.warn(`agente omitido (requiere id y command): ${JSON.stringify(agent)}`);
        continue;
    }
    const meta = {
        view: "term",
        controller: "cmd",
        cmd: agent.command,
        "cmd:shell": true,
        "cmd:runonstart": true,
    };
    const envRef = agent.environment ? catalog.environments.find((e) => e.id === agent.environment) : null;
    if (envRef && (envRef.kind === "ssh" || envRef.kind === "wsl")) {
        meta.connection = envRef.kind === "wsl" ? `wsl://${envRef.distro}` : envRef.host;
    }
    widgets[`nexus-agent-${agent.id}`] = {
        "display:order": 200 + agentCount,
        icon: agent.icon ?? "robot",
        color: agent.color ?? "#d2a8ff",
        label: agent.name ?? agent.id,
        description: `${agent.command}${meta.connection ? " @ " + meta.connection : ""}`,
        blockdef: { meta },
    };
    agentCount++;
}

// Catálogo para el frontend (indicador de ambiente en la tab bar): se proyecta
// como clave gestionada nexus:environments en settings.json. conn = clave de
// conexión de Wave (host ssh, wsl://distro, o "" para local).
const settingsPath = path.join(configDir, "settings.json");
const settings = readJson(settingsPath);
settings["nexus:environments"] = catalog.environments.map((env) => {
    const conn = env.kind === "wsl" ? `wsl://${env.distro ?? ""}` : env.kind === "ssh" ? (env.host ?? "") : "";
    const entry = { id: env.id, conn };
    if (env.name) entry.name = env.name;
    if (env.class) entry.class = env.class;
    if (env.kind) entry.kind = env.kind;
    if (env.color) entry.color = env.color;
    return entry;
});

console.log(`catálogo: ${yamlPath} (${catalog.environments.length} ambientes, ${connChanges} conexiones, ${widgetCount} widgets)`);
console.log(`config dir: ${configDir}`);
backupAndWrite(connPath, connections);
backupAndWrite(presetsPath, presets);
backupAndWrite(widgetsPath, widgets);
backupAndWrite(settingsPath, settings);
console.log("Listo:");
console.log("- Indicador de ambiente en la tab bar (bloque enfocado → ambiente del catálogo).");
console.log("- Barra lateral de widgets: un botón por ambiente (click = terminal en esa conexión).");
console.log("- Selector de conexiones: ambientes ssh/wsl con tema de terminal por clase.");
console.log("- Fondos 'Nexus: <clase>' en el menú contextual del tab (Backgrounds).");
