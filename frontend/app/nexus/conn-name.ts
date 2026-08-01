// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Nombre canónico de conexión: el backend NO guarda el string que le mandamos,
// guarda `ParseOpts(name)` y lo reporta como `SSHOpts.String()`
// (pkg/remote/connutil.go + pkg/remote/sshclient.go). Si el catálogo dice
// "ndf@host:22" y el backend dice "ndf@host", el punto de estado de la sidebar
// (getConnStatusAtom) y la búsqueda de bloques abiertos miran claves distintas y
// nunca coinciden. Estas funciones replican esa semántica exacta en el frontend.
//
// A propósito NO se baja a minúsculas el host: `ParseOpts` tampoco lo hace y los
// patrones `Host` de ~/.ssh/config se matchean sensibles a mayúsculas, así que
// normalizar el case produciría una clave que el backend jamás usa.

export const WslPrefix = "wsl://";

// Copia literal de userHostRe (pkg/remote/connutil.go): el backslash en la
// parte de usuario es lo que permite el "MAQUINA\usuario" de Windows.
const UserHostRe = /^([a-zA-Z0-9][a-zA-Z0-9._@\\-]*@)?([a-zA-Z0-9][a-zA-Z0-9.-]*)(?::([0-9]+))?$/;

export type ConnParts = {
    user: string;
    host: string;
    port: string;
};

export function isWslConnName(conn: string): boolean {
    return (conn ?? "").startsWith(WslPrefix);
}

// Devuelve null cuando el backend tampoco podría parsearlo (ParseOpts falla).
export function parseConnName(conn: string): ConnParts {
    const trimmed = (conn ?? "").trim();
    if (trimmed === "" || isWslConnName(trimmed)) {
        return null;
    }
    const m = UserHostRe.exec(trimmed);
    if (m == null) {
        return null;
    }
    return { user: (m[1] ?? "").replace(/@+$/, ""), host: m[2], port: m[3] ?? "" };
}

export function canonicalizeConnName(conn: string): string {
    const trimmed = (conn ?? "").trim();
    if (trimmed === "") {
        return "";
    }
    if (isWslConnName(trimmed)) {
        return WslPrefix + trimmed.slice(WslPrefix.length).trim();
    }
    const parts = parseConnName(trimmed);
    if (parts == null) {
        return trimmed;
    }
    return formatConnName(parts);
}

export function formatConnName(parts: ConnParts): string {
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

// El backend rechaza estos hosts en ParseOpts (guiones bajos, literales IPv6):
// la conexión falla con "invalid format of user@host argument".
export function connNameRejectedByBackend(conn: string): boolean {
    const trimmed = (conn ?? "").trim();
    if (trimmed === "" || isWslConnName(trimmed)) {
        return false;
    }
    return parseConnName(trimmed) == null;
}
