#!/usr/bin/env node
// Nexus Workbench — importa nexus/config/environments.yaml a la config nativa de Wave.
//
// Uso:  node nexus/scripts/import-environments.mjs [ruta.yaml] [--dev] [--dry-run]
//
// - Escribe entradas en <configDir>/connections.json (ssh y wsl) con term:theme
//   por clase de ambiente, y presets de fondo de tab en <configDir>/presets.json.
// - Merge NO destructivo: preserva claves existentes; solo crea/actualiza las
//   claves gestionadas. Hace backup timestampeado antes de escribir.
// - Identidad SÍ, credenciales NO: escribe ssh:user / ssh:port /
//   ssh:identityfile (rutas) para que el backend no tenga que adivinar el
//   usuario, y aborta si detecta material sensible. Contraseñas: secret store
//   (`wsh secret set` + ssh:passwordsecretname), nunca el catálogo.

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

// Nombre canónico de conexión: replica ParseOpts (pkg/remote/connutil.go) +
// SSHOpts.String() (pkg/remote/sshclient.go), que es la clave REAL con la que el
// backend indexa la conexión. Emitir "ndf@host:22" cuando el backend dice
// "ndf@host" hace que el punto de estado de la sidebar y la búsqueda de bloques
// abiertos nunca coincidan. Espejo de frontend/app/nexus/conn-name.ts (no se
// puede importar TS desde este script sin build).
const UserHostRe = /^([a-zA-Z0-9][a-zA-Z0-9._@\\-]*@)?([a-zA-Z0-9][a-zA-Z0-9.-]*)(?::([0-9]+))?$/;

function parseHostSpec(spec) {
    const m = UserHostRe.exec(String(spec ?? "").trim());
    if (m == null) {
        return null;
    }
    return { user: (m[1] ?? "").replace(/@+$/, ""), host: m[2], port: m[3] ?? "" };
}

function formatConn(parts) {
    let rtn = "";
    if (parts.user) {
        rtn += parts.user + "@";
    }
    rtn += parts.host;
    if (parts.port && parts.port !== "22") {
        rtn += ":" + parts.port;
    }
    return rtn;
}

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

// Guarda de credenciales. Se separa en dos porque `identityfile` es una RUTA a
// una clave, no material de clave: un path perfectamente legítimo como
// ~/.ssh/mi_private_key dispararía el patrón `private[_-]?key` y abortaría el
// import sin motivo. Se enmascara SOLO el valor de identityfile (hasta la coma o
// el fin de línea, para no tapar otra clave escrita en la misma línea) y solo
// frente a los patrones por NOMBRE. El cuerpo PEM se sigue buscando sobre el
// texto completo: una clave embebida nunca es aceptable, ni en identityfile.
const forbiddenNames = /password|passphrase|token|secret|private[_-]?key/i;
const forbiddenMaterial = /BEGIN (RSA|DSA|EC|OPENSSH|ENCRYPTED)?\s*PRIVATE KEY|BEGIN (RSA|OPENSSH)/i;
const rawSansComments = raw
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");
const rawSansIdentityPaths = rawSansComments.replace(/(["']?identityfile["']?\s*:\s*)([^,\n]*)/gi, "$1<ruta>");
if (forbiddenMaterial.test(rawSansComments) || forbiddenNames.test(rawSansIdentityPaths)) {
    console.error("ABORTADO: el catálogo parece contener material sensible (password/token/clave).");
    console.error("Para SSH con contraseña usá el secret store: `wsh secret set` + ssh:passwordsecretname.");
    process.exit(2);
}

// Validación + resolución del catálogo ANTES de escribir nada. Un ssh sin host
// producía `conn: ""` en silencio, y el sidebar/widget abría una shell LOCAL
// haciéndose pasar por el servidor; un wsl sin distro producía "wsl://" que no
// resuelve a ninguna distro. Los dos casos ahora abortan el import.
const resolved = new Map();
const catalogErrors = [];
const seenIds = new Set();
for (const env of catalog.environments) {
    const label = env?.id ?? JSON.stringify(env);
    if (!env?.id) {
        catalogErrors.push(`ambiente sin 'id': ${JSON.stringify(env)}`);
        continue;
    }
    if (seenIds.has(env.id)) {
        catalogErrors.push(`id duplicado '${env.id}': los ids deben ser únicos`);
        continue;
    }
    seenIds.add(env.id);
    if (env.kind === "wsl") {
        if (!env.distro) {
            catalogErrors.push(`'${label}': kind "wsl" requiere 'distro' (ver \`wsl -l\`)`);
            continue;
        }
        resolved.set(env.id, { conn: `wsl://${String(env.distro).trim()}` });
        continue;
    }
    if (env.kind !== "ssh") {
        resolved.set(env.id, { conn: "" });
        continue;
    }
    if (!env.host) {
        catalogErrors.push(`'${label}': kind "ssh" requiere 'host' (alias de ~/.ssh/config, o user@host[:port])`);
        continue;
    }
    // Aviso, no error: el host puede volverse válido si el usuario define un
    // alias en ~/.ssh/config, y un host raro no debe bloquear el resto del
    // catálogo. Pero tal como está, ParseOpts lo rechaza y la conexión falla.
    const rawHost = String(env.host).trim();
    const parts = parseHostSpec(rawHost) ?? { user: "", host: rawHost, port: "" };
    if (parseHostSpec(rawHost) == null) {
        const motivo = /_/.test(rawHost) ? "tiene guion bajo" : "parece un literal IPv6 u otro formato no soportado";
        console.warn(
            `AVISO '${label}': el host ${JSON.stringify(rawHost)} ${motivo} y ParseOpts lo RECHAZA ` +
                `(pkg/remote/connutil.go): la conexión va a fallar con "invalid format of user@host argument". ` +
                `Definí un alias en ~/.ssh/config y usalo como host.`
        );
    }
    if (env.user != null) {
        parts.user = String(env.user).trim();
    }
    if (env.port != null) {
        const port = String(env.port).trim();
        if (!/^[0-9]+$/.test(port)) {
            catalogErrors.push(`'${label}': port inválido ${JSON.stringify(env.port)} (debe ser numérico)`);
            continue;
        }
        parts.port = port;
    }
    if (env.wsh != null && typeof env.wsh !== "boolean") {
        catalogErrors.push(`'${label}': 'wsh' debe ser true o false`);
        continue;
    }
    const identityFile = env.identityfile == null ? [] : [].concat(env.identityfile).map((f) => String(f));
    resolved.set(env.id, { conn: formatConn(parts), ssh: parts, identityFile, wsh: env.wsh });
    if (!parts.user) {
        console.warn(
            `AVISO '${label}': sin 'user' — en Windows, si ~/.ssh/config no define User para '${parts.host}', ` +
                `Wave manda user.Current() ("MAQUINA\\usuario") y la autenticación falla. Agregá 'user:'.`
        );
    }
}
if (catalogErrors.length > 0) {
    console.error("ABORTADO: el catálogo tiene errores:");
    for (const e of catalogErrors) {
        console.error(`  - ${e}`);
    }
    process.exit(3);
}

function connForEnv(env) {
    return resolved.get(env?.id)?.conn ?? "";
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
    const info = resolved.get(env.id);
    const key = info.conn;
    const theme = env.theme ?? ClassThemes[env.class] ?? "default-dark";
    const entry = {
        ...connections[key],
        "display:order": catalog.environments.indexOf(env),
        "term:theme": theme,
    };
    if (env.kind === "ssh") {
        // Identidad explícita: sin esto, cuando ~/.ssh/config no define User,
        // sshclient.go cae a user.Current() — en Windows "MAQUINA\usuario", que
        // se manda tal cual como login SSH y la autenticación falla sin decir
        // por qué. Nunca va acá una credencial: usuario, host, puerto y RUTAS.
        if (info.ssh.user) {
            entry["ssh:user"] = info.ssh.user;
        }
        // NO se emite ssh:hostname: solo podría valer lo mismo que el nombre de
        // la conexión, que es exactamente lo que el backend ya deriva por
        // defecto (findSshConfigKeywords usa hostPattern cuando HostName está
        // vacío). Escribirlo no agrega información y sí rompe algo: en la
        // cascada de keywords, connections.json le gana a ~/.ssh/config, así que
        // un alias con `HostName 10.0.0.5` quedaría clavado al literal del alias.
        // Solo se escribe lo que el usuario declaró explícitamente.
        if (env.port != null) {
            entry["ssh:port"] = info.ssh.port;
        }
        if (info.identityFile.length > 0) {
            entry["ssh:identityfile"] = info.identityFile;
        }
        // wsh: false = modo WinSSHterm puro (shell remota sin instalar nada).
        if (env.wsh === false) {
            entry["conn:wshenabled"] = false;
        }
    }
    connections[key] = entry;
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
    if (
        key.startsWith("nexus-env-") ||
        key.startsWith("nexus-agent-") ||
        key.startsWith("nexus-cmd-") ||
        key.startsWith("nexus-link-") ||
        key === "nexus-jarvis"
    ) {
        delete widgets[key];
    }
}
let widgetCount = 0;
for (const env of catalog.environments) {
    const meta = { view: "term", controller: "shell" };
    const conn = connForEnv(env);
    if (conn) {
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
//
// Un agente puede declarar `modes: [{id, label, command, danger}]`: en ese caso
// se genera UN SOLO widget cuyo blockdef.meta lleva "nexus:modes" y el click
// abre un menú para elegir la variante (ver nexus/docs/AI.md). Sin `modes` el
// comportamiento es el de siempre.
function normalizeModes(raw, ctx) {
    if (raw == null) {
        return [];
    }
    if (!Array.isArray(raw)) {
        console.warn(`${ctx}: 'modes' debe ser una lista; ignorado`);
        return [];
    }
    const modes = [];
    for (const m of raw) {
        if (!m || typeof m !== "object" || !m.command) {
            console.warn(`${ctx}: modo omitido (requiere command): ${JSON.stringify(m)}`);
            continue;
        }
        const mode = { label: String(m.label ?? m.id ?? m.command), command: String(m.command) };
        if (m.danger === true) {
            mode.danger = true;
        }
        modes.push(mode);
    }
    return modes;
}

// Herramienta de una invocación: "claude --dangerously-skip-permissions" →
// "claude". Espejo de widgetBaseCommand() en frontend/app/nexus/ai-apps.ts.
function baseTool(command) {
    const first = String(command ?? "").trim().split(/\s+/)[0];
    const base = first.split(/[/\\]/).pop() ?? first;
    return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

const DangerFlagRe =
    /(^|\s)(--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo|--full-auto|--bypass-permissions)(\s|$)/;

// Un catálogo heredado declaraba una entrada por variante de permisos (claude,
// claude-full, codex, codex-full): cuatro botones para dos herramientas. Las
// entradas que comparten herramienta Y ambiente se funden en un solo agente con
// `modes` (D-031). La app hace el mismo plegado en la barra por si el catálogo
// no se vuelve a importar, pero acá se arregla el origen.
function collapseAgents(rawAgents) {
    const byKey = new Map();
    const order = [];
    for (const agent of rawAgents) {
        const modes = normalizeModes(agent.modes, `agente '${agent.id ?? "?"}'`);
        const command = agent.command ?? modes[0]?.command;
        if (!agent.id || !command) {
            console.warn(`agente omitido (requiere id y command o modes): ${JSON.stringify(agent)}`);
            continue;
        }
        const key = `${baseTool(command)}@${agent.environment ?? ""}`;
        const existing = byKey.get(key);
        if (existing == null) {
            byKey.set(key, { ...agent, command, modes });
            order.push(key);
            continue;
        }
        const merged = modes.length > 0 ? modes : [{ label: agent.name ?? agent.id, command }];
        const known = new Set(existing.modes.map((m) => m.command));
        if (existing.modes.length === 0) {
            existing.modes.push({ label: existing.name ?? existing.id, command: existing.command });
            known.add(existing.command);
        }
        for (const mode of merged) {
            if (known.has(mode.command)) {
                continue;
            }
            known.add(mode.command);
            existing.modes.push(DangerFlagRe.test(mode.command) ? { ...mode, danger: true } : mode);
        }
        console.warn(
            `agente '${agent.id}' FUNDIDO en '${existing.id}': misma herramienta (${baseTool(command)}) — ` +
                `un botón con ${existing.modes.length} modos en vez de dos botones`
        );
    }
    return order.map((k) => byKey.get(k));
}

const agentIds = new Set();
const agentCommands = new Map();
let agentCount = 0;
for (const agent of collapseAgents(catalog.agents ?? [])) {
    const modes = agent.modes;
    const baseCommand = agent.command;
    const meta = {
        view: "term",
        controller: "cmd",
        cmd: baseCommand,
        "cmd:shell": true,
        "cmd:runonstart": true,
    };
    if (modes.length > 0) {
        meta["nexus:modes"] = modes;
    }
    const envRef = agent.environment ? catalog.environments.find((e) => e.id === agent.environment) : null;
    if (envRef && connForEnv(envRef)) {
        meta.connection = connForEnv(envRef);
    }
    const label = agent.name ?? agent.id;
    widgets[`nexus-agent-${agent.id}`] = {
        "display:order": 200 + agentCount,
        icon: agent.icon ?? "robot",
        color: agent.color ?? "#d2a8ff",
        label,
        description:
            modes.length > 1
                ? `${label} — ${modes.length} modos${meta.connection ? " @ " + meta.connection : ""}`
                : `${baseCommand}${meta.connection ? " @ " + meta.connection : ""}`,
        blockdef: { meta },
    };
    agentIds.add(agent.id);
    for (const c of [baseCommand, ...modes.map((m) => m.command)]) {
        agentCommands.set(c.trim(), agent.id);
    }
    agentCount++;
}
if (agentCount > 0) {
    console.log(`agentes: ${agentCount} widgets`);
}

// Comandos favoritos (nexus/config/commands.yaml|.json, opcional): widgets que
// abren una terminal y corren el comando. Solo comandos seguros: los que tienen
// placeholders <...> o destructive=true NO se auto-ejecutan (quedan para la
// superficie Bridge.runCommand con confirmación — ver commands.example.yaml).
const cmdJson = path.join(scriptDir, "..", "config", "commands.json");
const cmdYaml = path.join(scriptDir, "..", "config", "commands.yaml");
const cmdPath = fs.existsSync(cmdJson) ? cmdJson : fs.existsSync(cmdYaml) ? cmdYaml : null;
let cmdCount = 0;
let cmdSkipped = 0;
let cmdDup = 0;
if (cmdPath) {
    const { parsed: cmdCatalog } = parseCatalogFile(cmdPath);
    if (cmdCatalog?.version !== 1 || !Array.isArray(cmdCatalog.commands)) {
        console.error(`Formato inválido en ${cmdPath}: se espera { version: 1, commands: [...] }`);
        process.exit(1);
    }
    for (const cmd of cmdCatalog.commands) {
        if (!cmd.id || !cmd.command) {
            console.warn(`comando omitido (requiere id y command): ${JSON.stringify(cmd)}`);
            continue;
        }
        if (cmd.destructive || /<[^>]+>/.test(cmd.command)) {
            cmdSkipped++;
            continue;
        }
        // Un botón por herramienta: si el comando ya lo cubre un agente (mismo
        // id, o mismo comando incluso bajo otro id) no generamos un segundo
        // widget que haga exactamente lo mismo.
        if (agentIds.has(cmd.id)) {
            console.warn(
                `comando '${cmd.id}' OMITIDO: colisiona con el agente '${cmd.id}' (mismo id) — el widget nexus-agent-${cmd.id} ya cubre esa herramienta`
            );
            cmdDup++;
            continue;
        }
        const dupAgentId = agentCommands.get(cmd.command.trim());
        if (dupAgentId != null) {
            console.warn(
                `comando '${cmd.id}' OMITIDO: su comando (${cmd.command}) es idéntico al del agente '${dupAgentId}' — el widget nexus-agent-${dupAgentId} ya cubre esa herramienta`
            );
            cmdDup++;
            continue;
        }
        const meta = {
            view: "term",
            controller: "cmd",
            cmd: cmd.command,
            "cmd:shell": true,
            "cmd:runonstart": true,
        };
        const envRef = cmd.environment ? catalog.environments.find((e) => e.id === cmd.environment) : null;
        if (envRef && connForEnv(envRef)) {
            meta.connection = connForEnv(envRef);
        }
        widgets[`nexus-cmd-${cmd.id}`] = {
            "display:order": 300 + cmdCount,
            icon: cmd.icon ?? "terminal",
            color: cmd.color ?? "#79c0ff",
            label: cmd.name ?? cmd.id,
            description: `${cmd.command}${meta.connection ? " @ " + meta.connection : ""}`,
            blockdef: { meta },
        };
        cmdCount++;
    }
    console.log(
        `comandos: ${cmdPath} (${cmdCount} widgets, ${cmdSkipped} omitidos por destructive/placeholder, ${cmdDup} omitidos por duplicar un agente)`
    );
}

// Links web (repos, dashboards): abren en el navegador embebido del Workbench
// (Chromium de Electron, sesión/cookies propias que PERSISTEN entre reinicios
// en el data dir de la app — el login de GitHub se hace una sola vez).
let linkCount = 0;
for (const link of catalog.links ?? []) {
    if (!link.id || !link.url) {
        console.warn(`link omitido (requiere id y url): ${JSON.stringify(link)}`);
        continue;
    }
    widgets[`nexus-link-${link.id}`] = {
        "display:order": 150 + linkCount,
        icon: link.icon ?? "globe",
        color: link.color ?? "#8b949e",
        label: link.name ?? link.id,
        description: link.url,
        blockdef: { meta: { view: "web", url: link.url } },
    };
    linkCount++;
}
if (linkCount > 0) {
    console.log(`links: ${linkCount} widgets web`);
}

// Jarvis NO se genera acá: el widget default `defwidget@jarvis` viaja con la
// app (defaultconfig/widgets.json) y no necesita que corra el importador. La
// clave `nexus-jarvis` sigue en la limpieza de arriba para borrar el duplicado
// que quedó en instalaciones donde este bloque sí llegó a correr.

// Catálogo para el frontend (indicador de ambiente en la tab bar): se proyecta
// como clave gestionada nexus:environments en settings.json. conn = clave de
// conexión de Wave (host ssh, wsl://distro, o "" para local).
const settingsPath = path.join(configDir, "settings.json");
const settings = readJson(settingsPath);
const generatedEnvs = catalog.environments.map((env) => {
    const entry = { id: env.id, conn: connForEnv(env) };
    if (env.name) entry.name = env.name;
    if (env.class) entry.class = env.class;
    if (env.kind) entry.kind = env.kind;
    if (env.color) entry.color = env.color;
    if (env.icon) entry.icon = env.icon;
    if (env.description) entry.description = env.description;
    if (env.group) entry.group = env.group;
    return entry;
});
// El administrador de la app (frontend/app/nexus/env-store.ts) escribe en esta
// MISMA clave. Asignar el .map() directamente borraba en silencio cada servidor
// dado de alta desde la UI: el importador solo es dueño de los ids que declara
// su catálogo, los demás se preservan tal cual.
const previousEnvs = Array.isArray(settings["nexus:environments"]) ? settings["nexus:environments"] : [];
const generatedIds = new Set(generatedEnvs.map((e) => e.id));
const preservedEnvs = previousEnvs.filter((e) => e?.id && !generatedIds.has(e.id));
settings["nexus:environments"] = [...generatedEnvs, ...preservedEnvs];
if (preservedEnvs.length > 0) {
    console.log(
        `ambientes preservados (creados desde la app, fuera del catálogo): ${preservedEnvs.length} — ` +
            preservedEnvs.map((e) => e.id).join(", ")
    );
}

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
