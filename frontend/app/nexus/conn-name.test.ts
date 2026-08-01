// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import { canonicalizeConnName, connNameRejectedByBackend, parseConnName } from "./conn-name";

test("canonicalizeConnName replica SSHOpts.String(): el :22 se omite", () => {
    assert.equal(canonicalizeConnName("ndf@192.168.50.105:22"), "ndf@192.168.50.105");
    assert.equal(canonicalizeConnName("ndf@192.168.50.105"), "ndf@192.168.50.105");
    assert.equal(canonicalizeConnName("ndf@192.168.50.105:2222"), "ndf@192.168.50.105:2222");
});

test("canonicalizeConnName preserva alias de ~/.ssh/config sin usuario", () => {
    assert.equal(canonicalizeConnName("nexusos"), "nexusos");
    assert.equal(canonicalizeConnName("nexusos:22"), "nexusos");
});

test("canonicalizeConnName no toca el case: ParseOpts tampoco y los patrones Host son sensibles", () => {
    assert.equal(canonicalizeConnName("MiServidor"), "MiServidor");
    assert.equal(canonicalizeConnName("Ndf@Host.Local:22"), "Ndf@Host.Local");
});

test("canonicalizeConnName normaliza espacios y vacíos", () => {
    assert.equal(canonicalizeConnName("  ndf@host:22  "), "ndf@host");
    assert.equal(canonicalizeConnName(""), "");
    assert.equal(canonicalizeConnName(null), "");
    assert.equal(canonicalizeConnName(undefined), "");
});

test("canonicalizeConnName deja wsl:// intacto (el distro es case-sensitive)", () => {
    assert.equal(canonicalizeConnName("wsl://Ubuntu"), "wsl://Ubuntu");
    assert.equal(canonicalizeConnName("  wsl://Ubuntu-22.04 "), "wsl://Ubuntu-22.04");
});

test("parseConnName acepta el usuario de Windows con backslash", () => {
    assert.deepEqual(parseConnName("MAQUINA\\ndf@192.168.50.105"), {
        user: "MAQUINA\\ndf",
        host: "192.168.50.105",
        port: "",
    });
});

test("connNameRejectedByBackend marca lo que ParseOpts rechaza", () => {
    assert.equal(connNameRejectedByBackend("host_con_guion_bajo"), true);
    assert.equal(connNameRejectedByBackend("fd00::1"), true);
    assert.equal(connNameRejectedByBackend("[fd00::1]:2222"), true);
    assert.equal(connNameRejectedByBackend("ndf@host-ok.local"), false);
    assert.equal(connNameRejectedByBackend("wsl://Ubuntu"), false);
    assert.equal(connNameRejectedByBackend(""), false);
});

test("un nombre que el backend rechaza se devuelve sin mutilar", () => {
    assert.equal(canonicalizeConnName("host_raro"), "host_raro");
});
