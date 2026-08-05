// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const SigningEnvVars = ["WIN_CSC_LINK", "CSC_LINK", "SM_CODE_SIGNING_CERT_SHA1_HASH", "NEXUS_PUBLISHER_NAME"];

// La config es un .cjs que lee process.env al evaluarse, así que hay que
// sacarla del cache de require entre casos.
function loadConfig(env: Record<string, string | undefined>) {
    for (const name of SigningEnvVars) {
        delete process.env[name];
    }
    Object.assign(process.env, env);
    const resolved = require.resolve("./electron-builder.config.cjs");
    delete require.cache[resolved];
    return require(resolved);
}

describe("configuración de firma de Windows", () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const name of SigningEnvVars) {
            saved[name] = process.env[name];
        }
    });

    afterEach(() => {
        for (const name of SigningEnvVars) {
            if (saved[name] == null) {
                delete process.env[name];
            } else {
                process.env[name] = saved[name];
            }
        }
    });

    it("sin certificado no firma y deja la verificación apagada", () => {
        const config = loadConfig({});
        expect(config.win.signtoolOptions).toBeUndefined();
        // prenderla sin firma haría que el updater rechace su propio artefacto
        expect(config.win.verifyUpdateCodeSignature).toBe(false);
    });

    it("con un .pfx firma y prende la verificación de la actualización", () => {
        const config = loadConfig({ WIN_CSC_LINK: "base64-del-pfx", NEXUS_PUBLISHER_NAME: "Nestor Fleitas" });
        expect(config.win.verifyUpdateCodeSignature).toBe(true);
        expect(config.win.signtoolOptions.publisherName).toBe("Nestor Fleitas");
        expect(config.win.signtoolOptions.signingHashAlgorithms).toEqual(["sha256"]);
        // con .pfx el certificado lo resuelve electron-builder por env, no por store
        expect(config.win.signtoolOptions.certificateSha1).toBeUndefined();
        expect(config.win.signtoolOptions.certificateSubjectName).toBeUndefined();
    });

    it("por thumbprint nombra el subject a buscar en el almacén", () => {
        const config = loadConfig({ SM_CODE_SIGNING_CERT_SHA1_HASH: "AABB", NEXUS_PUBLISHER_NAME: "Nestor Fleitas" });
        expect(config.win.signtoolOptions.certificateSha1).toBe("AABB");
        expect(config.win.signtoolOptions.certificateSubjectName).toBe("Nestor Fleitas");
    });

    // El publisher estaba hardcodeado a la empresa de upstream. Si no coincide
    // con el subject del certificado, el updater rechaza toda actualización.
    it("nunca queda apuntando al publisher de upstream", () => {
        const config = loadConfig({ WIN_CSC_LINK: "x" });
        expect(config.win.signtoolOptions.publisherName).not.toBe("Command Line Inc");
    });

    it("el feed de updates sigue apuntando al fork", () => {
        const config = loadConfig({});
        expect(config.publish).toMatchObject({ provider: "github", owner: "ndf14685", repo: "nexus-workbench" });
    });
});
