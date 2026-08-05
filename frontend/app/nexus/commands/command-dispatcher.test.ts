// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getRegisteredShortcutKeys } from "./command-dispatcher";

describe("global webview key registration", () => {
    it("does not steal the parts of a chord from the embedded page", () => {
        const keys = getRegisteredShortcutKeys();
        expect(keys).not.toContain("Ctrl:K");
        expect(keys).not.toContain("Ctrl:S");
    });

    it("still registers single-key shortcuts", () => {
        const keys = getRegisteredShortcutKeys();
        expect(keys).toContain("Ctrl:Alt:G");
        expect(keys).toContain("Ctrl:Shift:P");
    });
});
