// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { clampSummary, sanitizePanelContext, scrubSecrets } from "./panelactivity-util";

describe("scrubSecrets", () => {
    it("redacts key=value secret assignments", () => {
        expect(scrubSecrets("export API_KEY=abcd1234efgh5678")).toContain("[redacted]");
        expect(scrubSecrets("password: hunter2")).toBe("[redacted]");
        expect(scrubSecrets("Authorization: Bearer xyztokenvalue")).toContain("[redacted]");
    });
    it("redacts private key blocks", () => {
        // marker split across concatenation so the versioned-secret scanner (verify.sh) does not flag it
        const begin = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
        const end = "-----END OPENSSH " + "PRIVATE KEY-----";
        const input = begin + "\nabcd\n" + end;
        expect(scrubSecrets(input)).toBe("[redacted]");
    });
    it("redacts token-prefixed strings", () => {
        expect(scrubSecrets("ghp_0123456789abcdef0123")).toContain("[redacted]");
    });
    it("leaves ordinary text alone", () => {
        expect(scrubSecrets("Implementando pipeline OSINT en CyberLab")).toBe(
            "Implementando pipeline OSINT en CyberLab"
        );
    });
    it("handles empty / null", () => {
        expect(scrubSecrets("")).toBe("");
        expect(scrubSecrets(null)).toBe(null);
    });
});

describe("sanitizePanelContext", () => {
    it("scrubs secrets in note/url and marks the context sanitized", () => {
        const out = sanitizePanelContext({
            view: "term",
            customTitle: "CyberLab · OSINT",
            note: "token=supersecretvalue12345",
            connection: "ndf@192.168.50.105:22222",
            cwd: "/workspace/cyberlab",
        });
        expect(out.__sanitized).toBe(true);
        expect(out.note).toContain("[redacted]");
        expect(out.customTitle).toBe("CyberLab · OSINT");
        // connection is an identifier, not a secret
        expect(out.connection).toBe("ndf@192.168.50.105:22222");
    });
});

describe("clampSummary", () => {
    it("keeps at most 8 words", () => {
        expect(clampSummary("one two three four five six seven eight nine ten")).toBe(
            "one two three four five six seven eight"
        );
    });
    it("strips wrapping quotes and trailing punctuation", () => {
        expect(clampSummary('"Implementando pipeline OSINT."')).toBe("Implementando pipeline OSINT");
    });
    it("honors a custom max", () => {
        expect(clampSummary("a b c d e", 3)).toBe("a b c");
    });
    it("handles null", () => {
        expect(clampSummary(null)).toBe("");
    });
});
