// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// CRUD del catálogo de ambientes (`nexus:environments`) y su proyección a
// connections.json. Es la MISMA forma que emite nexus/scripts/import-environments.mjs:
// el importador es el bootstrap opcional, esta UI es el camino primario, y los
// dos tienen que producir bytes equivalentes o el usuario ve dos verdades.
//
// Credenciales: NUNCA en settings.json ni en connections.json. La contraseña va
// al secret store del SO (safeStorage/DPAPI) y a la config solo viaja su NOMBRE
// (`ssh:passwordsecretname`), que es lo que pkg/remote/sshclient.go resuelve.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { canonicalizeConnName, formatConnName, parseConnName } from "./conn-name";

export type EnvAuthMethod = "key" | "password" | "agent";

// Espejo de ClassThemes en el importador: el tema de terminal distingue el
// ambiente de un vistazo (D-003).
export const ClassThemes: Record<string, string> = {
    lab: "dracula",
    personal: "default-dark",
    work: "campbell",
    prod: "warmyellow",
};

export const DefaultTermTheme = "default-dark";
export const DefaultSshPort = "22";

// Regex del secret store (pkg/secretstore/secretstore.go). Un nombre que no
// matchea es rechazado por SetSecrets con error, así que la derivación tiene que
// garantizarlo por construcción, no confiar en el id.
export const SecretNameRegex = /^[A-Za-z][A-Za-z0-9_]*$/;
const SecretNamePrefix = "nexus_ssh_";

export type EnvFormValues = {
    id: string;
    name: string;
    kind: string;
    host: string;
    port: string;
    user: string;
    auth: EnvAuthMethod;
    identityfile: string;
    // Solo en memoria: nunca se persiste en config, va al secret store.
    password: string;
    description: string;
    group: string;
    class: string;
    color: string;
    icon: string;
    initscript: string;
    wsh: boolean;
};

export type EnvFormErrors = Partial<Record<keyof EnvFormValues, string>>;

export function emptyEnvForm(): EnvFormValues {
    return {
        id: "",
        name: "",
        kind: "ssh",
        host: "",
        port: DefaultSshPort,
        user: "",
        auth: "key",
        identityfile: "",
        password: "",
        description: "",
        group: "",
        class: "",
        color: "",
        icon: "",
        initscript: "",
        wsh: true,
    };
}

// El nombre del secreto se deriva del id (estable) y no del nombre visible, que
// el usuario puede renombrar sin querer perder la contraseña guardada.
export function secretNameForEnvId(envId: string): string {
    const sanitized = (envId ?? "").replace(/[^A-Za-z0-9_]/g, "_");
    return SecretNamePrefix + sanitized;
}

export function slugifyEnvId(name: string): string {
    const slug = (name ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug === "" ? "env" : slug;
}

export function uniqueEnvId(base: string, takenIds: string[]): string {
    const taken = new Set(takenIds ?? []);
    if (!taken.has(base)) {
        return base;
    }
    let n = 2;
    while (taken.has(`${base}-${n}`)) {
        n++;
    }
    return `${base}-${n}`;
}

export function validateEnvForm(form: EnvFormValues): EnvFormErrors {
    const errors: EnvFormErrors = {};
    if (!(form.name ?? "").trim()) {
        errors.name = "El nombre es obligatorio";
    }
    if (form.kind === "ssh") {
        if (!(form.host ?? "").trim()) {
            errors.host = "El host es obligatorio (alias de ~/.ssh/config, o user@host)";
        }
        const port = (form.port ?? "").trim();
        if (port !== "" && !/^[0-9]+$/.test(port)) {
            errors.port = "El puerto debe ser numérico";
        }
        if (form.auth === "key" && !(form.identityfile ?? "").trim()) {
            errors.identityfile = "Indicá la ruta de la clave privada";
        }
    }
    if (form.kind === "wsl" && !(form.host ?? "").trim()) {
        errors.host = "Indicá la distro de WSL (ver `wsl -l`)";
    }
    return errors;
}

export function hasErrors(errors: EnvFormErrors): boolean {
    return Object.keys(errors).length > 0;
}

// Réplica exacta de la resolución del importador: se parsea el host como
// user@host:port y los campos explícitos del formulario ganan.
export function connForForm(form: EnvFormValues): string {
    const rawHost = (form.host ?? "").trim();
    if (form.kind === "wsl") {
        return rawHost === "" ? "" : `wsl://${rawHost}`;
    }
    if (form.kind !== "ssh" || rawHost === "") {
        return "";
    }
    const parts = parseConnName(rawHost) ?? { user: "", host: rawHost, port: "" };
    const user = (form.user ?? "").trim();
    if (user !== "") {
        parts.user = user;
    }
    const port = (form.port ?? "").trim();
    if (port !== "") {
        parts.port = port;
    }
    return formatConnName(parts);
}

export function envFromForm(form: EnvFormValues): NexusEnvType {
    const env: NexusEnvType = {
        id: form.id,
        conn: connForForm(form),
    };
    const put = (key: keyof NexusEnvType, value: string) => {
        const trimmed = (value ?? "").trim();
        if (trimmed !== "") {
            (env as any)[key] = trimmed;
        }
    };
    put("name", form.name);
    put("class", form.class);
    put("kind", form.kind);
    put("color", form.color);
    put("icon", form.icon);
    put("description", form.description);
    put("group", form.group);
    put("initscript", form.initscript);
    if (form.kind === "ssh") {
        put("user", form.user);
        put("port", form.port);
        const identity = (form.identityfile ?? "").trim();
        if (form.auth === "key" && identity !== "") {
            env.identityfile = [identity];
        }
    }
    // Solo se guarda el opt-out: `wsh: true` es el default del motor y
    // escribirlo llenaría el catálogo de ruido.
    if (!form.wsh) {
        env.wsh = false;
    }
    return env;
}

// Reconstruye el formulario desde el catálogo. `host` sale del conn canónico
// (sin user ni puerto) para que los tres campos no se dupliquen entre sí.
// `connEntry` es la entrada de connections.json: es la ÚNICA fuente que dice si
// este servidor usa contraseña, porque el catálogo jamás guarda esa decisión
// (solo el nombre del secreto, que vive del lado de la conexión).
export function formFromEnv(env: NexusEnvType, connEntry?: ConnKeywords): EnvFormValues {
    const form = emptyEnvForm();
    if (env == null) {
        return form;
    }
    const secretName = connEntry?.["ssh:passwordsecretname"] ?? "";
    form.id = env.id ?? "";
    form.name = env.name ?? "";
    form.kind = env.kind ?? "ssh";
    form.class = env.class ?? "";
    form.color = env.color ?? "";
    form.icon = env.icon ?? "";
    form.description = env.description ?? "";
    form.group = env.group ?? "";
    form.initscript = env.initscript ?? "";
    form.wsh = env.wsh !== false;
    const conn = canonicalizeConnName(env.conn ?? "");
    if (form.kind === "wsl") {
        form.host = conn.startsWith("wsl://") ? conn.slice("wsl://".length) : "";
        form.port = "";
        return form;
    }
    const parts = parseConnName(conn);
    form.host = parts?.host ?? conn;
    form.user = env.user ?? parts?.user ?? "";
    form.port = env.port ?? parts?.port ?? DefaultSshPort;
    form.identityfile = env.identityfile?.[0] ?? "";
    form.auth = secretName !== "" ? "password" : form.identityfile !== "" ? "key" : "agent";
    return form;
}

export type PasswordPlan = {
    // undefined = no tocar el secreto guardado.
    password?: string;
    secretName: string;
    error?: string;
};

// Decide qué hacer con el secreto al guardar. Es su propia función porque es la
// regla más fácil de romper de todo el administrador: escribir "" cuando el
// usuario no tocó el campo BORRARÍA la contraseña guardada, y el síntoma
// aparecería recién en la próxima conexión.
export function passwordPlanForSave(args: {
    envId: string;
    auth: EnvAuthMethod;
    password: string;
    hasStoredPassword: boolean;
}): PasswordPlan {
    const typed = args.password ?? "";
    if (args.auth !== "password") {
        // Cambió de método: el secreto viejo se borra, no queda huérfano.
        return { password: args.hasStoredPassword ? "" : undefined, secretName: "" };
    }
    const secretName = secretNameForEnvId(args.envId);
    if (typed !== "") {
        return { password: typed, secretName };
    }
    if (args.hasStoredPassword) {
        return { secretName };
    }
    return { secretName, error: "La contraseña es obligatoria" };
}

export function upsertEnv(envs: NexusEnvType[], env: NexusEnvType): NexusEnvType[] {
    const list = [...(envs ?? [])];
    const idx = list.findIndex((e) => e?.id === env.id);
    if (idx < 0) {
        list.push(env);
        return list;
    }
    list[idx] = env;
    return list;
}

export function deleteEnv(envs: NexusEnvType[], envId: string): NexusEnvType[] {
    return (envs ?? []).filter((e) => e?.id !== envId);
}

export function duplicateEnvForm(envs: NexusEnvType[], envId: string, connEntry?: ConnKeywords): EnvFormValues {
    const src = (envs ?? []).find((e) => e?.id === envId);
    if (src == null) {
        return emptyEnvForm();
    }
    const form = formFromEnv(src, connEntry);
    form.name = `${form.name || src.id} (copia)`;
    form.id = uniqueEnvId(
        slugifyEnvId(form.name),
        (envs ?? []).map((e) => e?.id)
    );
    return form;
}

export type ConnEntry = Record<string, any>;

// Claves que este módulo (y el importador) declaran suyas en connections.json.
// Se escriben SIEMPRE, con null cuando no aplican: SetConnectionsConfigValue
// hace merge y no borra, así que omitir una clave dejaría pegado el valor viejo
// (cambiar de contraseña a clave seguiría mandando ssh:passwordsecretname).
export const OwnedConnKeys = [
    "display:order",
    "term:theme",
    "ssh:user",
    "ssh:port",
    "ssh:identityfile",
    "ssh:passwordsecretname",
    "conn:wshenabled",
    "cmd:initscript",
] as const;

export function themeForEnv(env: NexusEnvType): string {
    return ClassThemes[env?.class] ?? DefaultTermTheme;
}

// NO se emite ssh:hostname, igual que el importador: en la cascada de keywords
// connections.json le gana a ~/.ssh/config, así que escribirlo clavaría un alias
// a su propio literal y rompería `HostName 10.0.0.5`.
export function connEntryForEnv(env: NexusEnvType, order: number, secretName: string): ConnEntry {
    const entry: ConnEntry = {};
    for (const key of OwnedConnKeys) {
        entry[key] = null;
    }
    entry["display:order"] = order;
    entry["term:theme"] = themeForEnv(env);
    if ((env.initscript ?? "").trim() !== "") {
        entry["cmd:initscript"] = env.initscript.trim();
    }
    if (env.kind !== "ssh") {
        return entry;
    }
    if ((env.user ?? "").trim() !== "") {
        entry["ssh:user"] = env.user.trim();
    }
    if ((env.port ?? "").trim() !== "") {
        entry["ssh:port"] = env.port.trim();
    }
    if (env.identityfile?.length > 0) {
        entry["ssh:identityfile"] = [...env.identityfile];
    }
    if (env.wsh === false) {
        entry["conn:wshenabled"] = false;
    }
    if ((secretName ?? "") !== "") {
        entry["ssh:passwordsecretname"] = secretName;
    }
    return entry;
}

// Entrada de borrado: anula todas las claves propias. NO borra la entrada de la
// conexión — SetConnectionsConfigValue solo mergea (pkg/wconfig/settingsconfig.go),
// no tiene forma de eliminar una clave ni un host del archivo.
export function clearedConnEntry(): ConnEntry {
    const entry: ConnEntry = {};
    for (const key of OwnedConnKeys) {
        entry[key] = null;
    }
    return entry;
}

export type PersistEnvOptions = {
    envs: NexusEnvType[];
    env: NexusEnvType;
    // undefined = no tocar el secreto (el usuario no escribió una contraseña
    // nueva); "" = borrarlo; string = guardarlo.
    password?: string;
    // El nombre del secreto que la conexión debe referenciar. null cuando el
    // método de auth no es contraseña.
    secretName?: string;
};

export async function persistEnv(opts: PersistEnvOptions): Promise<NexusEnvType[]> {
    const { env, password, secretName } = opts;
    const nextEnvs = upsertEnv(opts.envs, env);
    const order = nextEnvs.findIndex((e) => e?.id === env.id);
    if (password != null) {
        const name = secretNameForEnvId(env.id);
        await RpcApi.SetSecretsCommand(TabRpcClient, { [name]: password === "" ? null : password } as any);
    }
    const conn = canonicalizeConnName(env.conn ?? "");
    if (conn !== "") {
        await RpcApi.SetConnectionsConfigCommand(TabRpcClient, {
            host: conn,
            metamaptype: connEntryForEnv(env, order, secretName ?? ""),
        });
    }
    await RpcApi.SetConfigCommand(TabRpcClient, { "nexus:environments": nextEnvs });
    return nextEnvs;
}

export async function removeEnv(envs: NexusEnvType[], envId: string): Promise<NexusEnvType[]> {
    const env = (envs ?? []).find((e) => e?.id === envId);
    const nextEnvs = deleteEnv(envs, envId);
    const conn = canonicalizeConnName(env?.conn ?? "");
    if (conn !== "") {
        await RpcApi.SetConnectionsConfigCommand(TabRpcClient, {
            host: conn,
            metamaptype: clearedConnEntry(),
        });
    }
    await RpcApi.SetSecretsCommand(TabRpcClient, { [secretNameForEnvId(envId)]: null } as any);
    await RpcApi.SetConfigCommand(TabRpcClient, { "nexus:environments": nextEnvs });
    return nextEnvs;
}
