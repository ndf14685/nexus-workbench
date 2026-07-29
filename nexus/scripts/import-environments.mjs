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

const require = createRequire(new URL("../../package.json", import.meta.url));
const YAML = require("yaml");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const isDev = args.includes("--dev");
const yamlPath =
    args.find((a) => !a.startsWith("--")) ??
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config", "environments.yaml");

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
    console.error("Copiá nexus/config/environments.example.yaml a nexus/config/environments.yaml y editalo.");
    process.exit(1);
}

const catalog = YAML.parse(fs.readFileSync(yamlPath, "utf8"));
if (catalog?.version !== 1 || !Array.isArray(catalog.environments)) {
    console.error("Formato inválido: se espera { version: 1, environments: [...] }");
    process.exit(1);
}

const forbidden = /password|passphrase|token|secret|private[_-]?key|BEGIN (RSA|OPENSSH)/i;
const yamlSansComments = fs
    .readFileSync(yamlPath, "utf8")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");
if (forbidden.test(yamlSansComments)) {
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

console.log(`catálogo: ${yamlPath} (${catalog.environments.length} ambientes, ${connChanges} conexiones)`);
console.log(`config dir: ${configDir}`);
backupAndWrite(connPath, connections);
backupAndWrite(presetsPath, presets);
console.log("Listo. Los ambientes ssh/wsl aparecen en el selector de conexiones de Wave");
console.log("con tema de terminal por clase; los fondos 'Nexus: <clase>' quedan disponibles");
console.log("en el menú contextual del tab (Backgrounds) para marcar tabs por ambiente.");
