#!/usr/bin/env node
// Nexus Workbench — crea workspaces declarativos desde nexus/config/workspaces.yaml
// vía `wsh workspace create` (RPC WorkspaceCreateCommand).
//
// Uso:  node nexus/scripts/import-workspaces.mjs [workspaces.yaml] [--dry-run]
//
// - Debe correr DENTRO de una terminal de Nexus Workbench (necesita `wsh`
//   conectado a la instancia en ejecución).
// - Idempotente por nombre: si ya existe un workspace con el mismo nombre, se
//   omite (los workspaces viven en el SQLite de Wave; no hay merge).
// - Resuelve environment ids contra nexus/config/environments.yaml|.json.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

function parseCatalogFile(p) {
    const raw = fs.readFileSync(p, "utf8");
    if (p.endsWith(".json")) {
        return JSON.parse(raw);
    }
    let YAML;
    try {
        const require = createRequire(new URL("../../package.json", import.meta.url));
        YAML = require("yaml");
    } catch {
        console.error("Falta el paquete 'yaml'. Opciones:");
        console.error("  npm install yaml --no-save --ignore-scripts --workspaces=false");
        console.error("  ...o usá catálogos .json que no necesitan nada.");
        process.exit(1);
    }
    return YAML.parse(raw);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cfgDir = path.join(scriptDir, "..", "config");

function findCatalog(base) {
    for (const ext of [".json", ".yaml"]) {
        const p = path.join(cfgDir, base + ext);
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

const wsPath = args.find((a) => !a.startsWith("--")) ?? findCatalog("workspaces");
if (!wsPath || !fs.existsSync(wsPath)) {
    console.error("No existe el catálogo de workspaces.");
    console.error("Copiá nexus/config/workspaces.example.yaml a nexus/config/workspaces.yaml y editalo.");
    process.exit(1);
}
const wsCatalog = parseCatalogFile(wsPath);
if (wsCatalog?.version !== 1 || !Array.isArray(wsCatalog.workspaces)) {
    console.error("Formato inválido: se espera { version: 1, workspaces: [...] }");
    process.exit(1);
}

const envPath = findCatalog("environments");
const envCatalog = envPath ? parseCatalogFile(envPath) : { environments: [] };
const envById = new Map((envCatalog.environments ?? []).map((e) => [e.id, e]));

function connFor(envId) {
    if (!envId) {
        return null;
    }
    const env = envById.get(envId);
    if (!env) {
        console.warn(`  ambiente desconocido: ${envId} (el bloque queda local)`);
        return null;
    }
    if (env.kind === "wsl") {
        return `wsl://${env.distro ?? ""}`;
    }
    if (env.kind === "ssh") {
        return env.host ?? null;
    }
    return null;
}

function blockFor(item) {
    const meta = {};
    if (item.view === "term" || item.view == null) {
        meta.view = "term";
        meta.controller = "shell";
    } else {
        meta.view = item.view;
    }
    if (item.path && meta.view === "preview") {
        meta.file = item.path;
    }
    if (item.url && meta.view === "web") {
        meta.url = item.url;
    }
    const conn = connFor(item.environment);
    if (conn) {
        meta.connection = conn;
    }
    return { meta };
}

function existingWorkspaceNames() {
    const res = spawnSync("wsh", ["workspace", "list"], { encoding: "utf8" });
    if (res.error || res.status !== 0) {
        console.error(`No pude listar workspaces via wsh (¿estás dentro de Nexus Workbench?): ${res.error ?? res.stderr}`);
        process.exit(1);
    }
    return new Set([...res.stdout.matchAll(/"name":\s*"([^"]*)"/g)].map((m) => m[1]));
}

const existing = dryRun ? new Set() : existingWorkspaceNames();
let created = 0;
let skipped = 0;
for (const ws of wsCatalog.workspaces) {
    if (!ws.id || !Array.isArray(ws.layout) || ws.layout.length === 0) {
        console.warn(`workspace omitido (requiere id y layout no vacío): ${JSON.stringify(ws.id ?? ws)}`);
        continue;
    }
    const name = ws.name ?? ws.id;
    if (existing.has(name)) {
        console.log(`ya existe, omitido: ${name}`);
        skipped++;
        continue;
    }
    const data = {
        name,
        icon: ws.icon ?? "",
        color: ws.color ?? "",
        tabname: ws.tabname ?? "",
        blocks: ws.layout.map(blockFor),
    };
    if (dryRun) {
        console.log(`[dry-run] crearía "${name}":`);
        console.log(JSON.stringify(data, null, 4));
        continue;
    }
    const out = execFileSync("wsh", ["workspace", "create", "--json", "-"], {
        input: JSON.stringify(data),
        encoding: "utf8",
    }).trim();
    console.log(`creado: ${name} (${out})`);
    created++;
}
if (!dryRun) {
    console.log(`Listo: ${created} creados, ${skipped} ya existían. Abrilos desde el switcher de workspaces.`);
}
