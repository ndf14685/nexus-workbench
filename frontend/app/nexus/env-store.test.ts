// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { assert, beforeEach, test, vi } from "vitest";

const rpcCalls: [string, any][] = [];

vi.mock("@/app/store/wshclientapi", () => {
    const record = (command: string) => {
        return (_client: any, data?: any) => {
            rpcCalls.push([command, data]);
            return Promise.resolve();
        };
    };
    return {
        RpcApi: {
            SetConfigCommand: record("SetConfigCommand"),
            SetConnectionsConfigCommand: record("SetConnectionsConfigCommand"),
            SetSecretsCommand: record("SetSecretsCommand"),
        },
    };
});
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import {
    clearedConnEntry,
    connEntryForEnv,
    connForForm,
    deleteEnv,
    duplicateEnvForm,
    emptyEnvForm,
    EnvFormValues,
    envFromForm,
    formFromEnv,
    hasErrors,
    OwnedConnKeys,
    persistEnv,
    removeEnv,
    SecretNameRegex,
    secretNameForEnvId,
    slugifyEnvId,
    uniqueEnvId,
    upsertEnv,
    validateEnvForm,
} from "./env-store";

beforeEach(() => {
    rpcCalls.length = 0;
});

function sshForm(over: Partial<EnvFormValues> = {}): EnvFormValues {
    return {
        ...emptyEnvForm(),
        id: "rig3060",
        name: "rig3060",
        kind: "ssh",
        host: "192.168.50.105",
        user: "ndf",
        class: "lab",
        identityfile: "~/.ssh/id_ed25519",
        ...over,
    };
}

const stripNulls = (entry: Record<string, any>) =>
    Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null));

test("validación: nombre obligatorio, ssh exige host, wsl exige distro", () => {
    assert.equal(validateEnvForm(sshForm()).name, undefined);
    assert.equal(validateEnvForm(sshForm({ name: "   " })).name, "El nombre es obligatorio");
    assert.match(validateEnvForm(sshForm({ host: "" })).host, /host es obligatorio/);
    assert.match(validateEnvForm({ ...emptyEnvForm(), name: "u", kind: "wsl", host: "" }).host, /distro/);
    assert.equal(validateEnvForm({ ...emptyEnvForm(), name: "u", kind: "wsl", host: "Ubuntu" }).host, undefined);
    assert.equal(validateEnvForm(sshForm({ port: "abc" })).port, "El puerto debe ser numérico");
    assert.equal(validateEnvForm(sshForm({ port: "" })).port, undefined);
    assert.isTrue(hasErrors(validateEnvForm(sshForm({ name: "" }))));
    assert.isFalse(hasErrors(validateEnvForm(sshForm())));
});

test("validación: el método clave exige una ruta de clave privada", () => {
    assert.match(validateEnvForm(sshForm({ auth: "key", identityfile: "" })).identityfile, /clave privada/);
    assert.equal(validateEnvForm(sshForm({ auth: "agente" as any, identityfile: "" })).identityfile, undefined);
    assert.equal(validateEnvForm(sshForm({ auth: "password", identityfile: "" })).identityfile, undefined);
});

test("conn canónico: el puerto 22 se omite y los campos explícitos ganan al host", () => {
    assert.equal(connForForm(sshForm({ port: "22" })), "ndf@192.168.50.105");
    assert.equal(connForForm(sshForm({ port: "2222" })), "ndf@192.168.50.105:2222");
    assert.equal(connForForm(sshForm({ host: "otro@host:9000", user: "ndf", port: "22" })), "ndf@host");
    assert.equal(connForForm(sshForm({ host: "alias-ssh", user: "", port: "22" })), "alias-ssh");
    assert.equal(connForForm({ ...emptyEnvForm(), kind: "wsl", host: "Ubuntu" }), "wsl://Ubuntu");
    assert.equal(connForForm({ ...emptyEnvForm(), kind: "local", host: "" }), "");
});

test("envFromForm omite vacíos y solo guarda el opt-out de wsh", () => {
    const env = envFromForm(sshForm({ description: "  ", group: "Producción", initscript: "cd /srv" }));
    assert.deepEqual(env, {
        id: "rig3060",
        conn: "ndf@192.168.50.105",
        name: "rig3060",
        class: "lab",
        kind: "ssh",
        group: "Producción",
        initscript: "cd /srv",
        user: "ndf",
        port: "22",
        identityfile: ["~/.ssh/id_ed25519"],
    });
    assert.equal(envFromForm(sshForm({ wsh: true })).wsh, undefined);
    assert.equal(envFromForm(sshForm({ wsh: false })).wsh, false);
    assert.equal(envFromForm(sshForm({ auth: "password", identityfile: "x" })).identityfile, undefined);
});

test("formFromEnv reconstruye el formulario sin duplicar user/puerto dentro del host", () => {
    const env = envFromForm(sshForm({ port: "2222", wsh: false, group: "Prod" }));
    const form = formFromEnv(env);
    assert.equal(form.host, "192.168.50.105");
    assert.equal(form.user, "ndf");
    assert.equal(form.port, "2222");
    assert.equal(form.identityfile, "~/.ssh/id_ed25519");
    assert.equal(form.auth, "key");
    assert.equal(form.wsh, false);
    assert.equal(form.group, "Prod");
    assert.equal(connForForm(form), env.conn);
});

test("formFromEnv: sin clave el método es agente, y wsl vuelve a su distro", () => {
    assert.equal(formFromEnv({ id: "a", kind: "ssh", conn: "ndf@h" } as NexusEnvType).auth, "agent");
    const wsl = formFromEnv({ id: "w", kind: "wsl", conn: "wsl://Ubuntu" } as NexusEnvType);
    assert.equal(wsl.host, "Ubuntu");
    assert.equal(formFromEnv(null).kind, "ssh");
});

test("derivación del nombre de secreto: siempre válida para el secret store", () => {
    assert.equal(secretNameForEnvId("rig3060"), "nexus_ssh_rig3060");
    assert.equal(secretNameForEnvId("mi-servidor.prod"), "nexus_ssh_mi_servidor_prod");
    assert.equal(secretNameForEnvId("9 raro!"), "nexus_ssh_9_raro_");
    for (const id of ["rig3060", "mi-servidor.prod", "9 raro!", "", "ñandú"]) {
        assert.match(secretNameForEnvId(id), SecretNameRegex, `id ${JSON.stringify(id)}`);
    }
});

test("ids: slug estable y único frente al catálogo", () => {
    assert.equal(slugifyEnvId("  Mi Servidor PROD  "), "mi-servidor-prod");
    assert.equal(slugifyEnvId("!!!"), "env");
    assert.equal(uniqueEnvId("web", []), "web");
    assert.equal(uniqueEnvId("web", ["web"]), "web-2");
    assert.equal(uniqueEnvId("web", ["web", "web-2", "web-3"]), "web-4");
});

test("CRUD del catálogo: alta, edición en su lugar, borrado y duplicado", () => {
    const a = envFromForm(sshForm());
    let envs = upsertEnv([], a);
    assert.deepEqual(envs.map((e) => e.id), ["rig3060"]);
    envs = upsertEnv(envs, { ...a, name: "renombrado" });
    assert.equal(envs.length, 1);
    assert.equal(envs[0].name, "renombrado");
    envs = upsertEnv(envs, envFromForm(sshForm({ id: "otro", name: "Otro", host: "h2" })));
    assert.deepEqual(envs.map((e) => e.id), ["rig3060", "otro"]);

    const copy = duplicateEnvForm(envs, "rig3060");
    assert.equal(copy.name, "renombrado (copia)");
    assert.equal(copy.id, "renombrado-copia");
    assert.equal(copy.host, "192.168.50.105");
    assert.equal(duplicateEnvForm(envs, "no-existe").name, "");

    envs = deleteEnv(envs, "rig3060");
    assert.deepEqual(envs.map((e) => e.id), ["otro"]);
    assert.deepEqual(deleteEnv(null, "x"), []);
});

test("un id duplicado del duplicado no pisa al original", () => {
    const envs = [envFromForm(sshForm({ id: "web", name: "web" }))];
    const first = duplicateEnvForm(envs, "web");
    const withCopy = upsertEnv(envs, envFromForm(first));
    const second = duplicateEnvForm(withCopy, "web");
    assert.equal(second.id, "web-copia-2");
});

test("payload de connections.json: idéntico al importador (sin ssh:hostname)", () => {
    const env = envFromForm(sshForm({ port: "2222", wsh: false, initscript: "tmux a" }));
    const entry = connEntryForEnv(env, 3, "");
    assert.deepEqual(stripNulls(entry), {
        "display:order": 3,
        "term:theme": "dracula",
        "ssh:user": "ndf",
        "ssh:port": "2222",
        "ssh:identityfile": ["~/.ssh/id_ed25519"],
        "conn:wshenabled": false,
        "cmd:initscript": "tmux a",
    });
    assert.notProperty(entry, "ssh:hostname");
    assert.deepEqual(Object.keys(entry).sort(), [...OwnedConnKeys].sort());
});

test("payload: wsh true y clase desconocida no ensucian la entrada", () => {
    const entry = connEntryForEnv(envFromForm(sshForm({ class: "", wsh: true, auth: "agent" })), 0, "");
    assert.deepEqual(stripNulls(entry), {
        "display:order": 0,
        "term:theme": "default-dark",
        "ssh:user": "ndf",
        "ssh:port": "22",
    });
});

test("payload wsl: solo orden y tema, las claves ssh quedan anuladas", () => {
    const env = envFromForm({ ...emptyEnvForm(), id: "u", name: "U", kind: "wsl", host: "Ubuntu", class: "work" });
    const entry = connEntryForEnv(env, 1, "");
    assert.deepEqual(stripNulls(entry), { "display:order": 1, "term:theme": "campbell" });
    assert.isNull(entry["ssh:user"]);
});

test("el nombre del secreto viaja a connections.json, la contraseña nunca", () => {
    const env = envFromForm(sshForm({ auth: "password", identityfile: "", password: "s3cr3t" }));
    const entry = connEntryForEnv(env, 0, "nexus_ssh_rig3060");
    assert.equal(entry["ssh:passwordsecretname"], "nexus_ssh_rig3060");
    assert.isNull(entry["ssh:identityfile"]);
    // Lo que no puede aparecer es el VALOR: la clave ssh:passwordsecretname
    // contiene la palabra "password" por definición del keyword de Wave.
    assert.notInclude(JSON.stringify(entry), "s3cr3t");
    assert.notInclude(JSON.stringify(env), "s3cr3t");
    assert.notProperty(env, "password");
});

test("claves propias anuladas al borrar (SetConnectionsConfig solo mergea)", () => {
    const cleared = clearedConnEntry();
    assert.deepEqual(Object.keys(cleared).sort(), [...OwnedConnKeys].sort());
    assert.isTrue(Object.values(cleared).every((v) => v === null));
});

test("persistEnv escribe secreto, conexión y catálogo en ese orden", async () => {
    const env = envFromForm(sshForm({ auth: "password", identityfile: "" }));
    const envs = await persistEnv({ envs: [], env, password: "s3cr3t", secretName: "nexus_ssh_rig3060" });
    assert.deepEqual(envs.map((e) => e.id), ["rig3060"]);
    assert.deepEqual(
        rpcCalls.map(([c]) => c),
        ["SetSecretsCommand", "SetConnectionsConfigCommand", "SetConfigCommand"]
    );
    assert.deepEqual(rpcCalls[0][1], { nexus_ssh_rig3060: "s3cr3t" });
    assert.equal(rpcCalls[1][1].host, "ndf@192.168.50.105");
    assert.equal(rpcCalls[1][1].metamaptype["ssh:passwordsecretname"], "nexus_ssh_rig3060");
    assert.deepEqual(rpcCalls[2][1], { "nexus:environments": envs });
    assert.notInclude(JSON.stringify(rpcCalls.slice(1)), "s3cr3t");
});

test("persistEnv NO toca el secreto cuando el usuario no escribió una contraseña nueva", async () => {
    const env = envFromForm(sshForm({ auth: "password", identityfile: "" }));
    await persistEnv({ envs: [], env, secretName: "nexus_ssh_rig3060" });
    assert.deepEqual(
        rpcCalls.map(([c]) => c),
        ["SetConnectionsConfigCommand", "SetConfigCommand"]
    );
    assert.equal(rpcCalls[0][1].metamaptype["ssh:passwordsecretname"], "nexus_ssh_rig3060");
});

test("persistEnv borra el secreto cuando se pasa a otro método de auth", async () => {
    const env = envFromForm(sshForm({ auth: "key" }));
    await persistEnv({ envs: [], env, password: "" });
    assert.deepEqual(rpcCalls[0], ["SetSecretsCommand", { nexus_ssh_rig3060: null }]);
    assert.isNull(rpcCalls[1][1].metamaptype["ssh:passwordsecretname"]);
});

test("persistEnv de un local sin conn no escribe connections.json", async () => {
    const env = envFromForm({ ...emptyEnvForm(), id: "loc", name: "Local", kind: "local" });
    await persistEnv({ envs: [], env });
    assert.deepEqual(
        rpcCalls.map(([c]) => c),
        ["SetConfigCommand"]
    );
});

test("persistEnv reindexa display:order según la posición en el catálogo", async () => {
    const a = envFromForm(sshForm({ id: "a", name: "A", host: "ha" }));
    const b = envFromForm(sshForm({ id: "b", name: "B", host: "hb" }));
    await persistEnv({ envs: [a], env: b });
    assert.equal(rpcCalls[0][1].metamaptype["display:order"], 1);
});

test("borrar un ambiente limpia catálogo, claves de conexión y secreto", async () => {
    const env = envFromForm(sshForm());
    const envs = await removeEnv([env], "rig3060");
    assert.deepEqual(envs, []);
    assert.deepEqual(
        rpcCalls.map(([c]) => c),
        ["SetConnectionsConfigCommand", "SetSecretsCommand", "SetConfigCommand"]
    );
    assert.equal(rpcCalls[0][1].host, "ndf@192.168.50.105");
    assert.isTrue(Object.values(rpcCalls[0][1].metamaptype).every((v) => v === null));
    assert.deepEqual(rpcCalls[1][1], { nexus_ssh_rig3060: null });
    assert.deepEqual(rpcCalls[2][1], { "nexus:environments": [] });
});
