// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "./command-registry";

describe("CommandRegistry", () => {
    it("registers and executes commands", async () => {
        const registry = new CommandRegistry();
        const handler = vi.fn(() => true);
        registry.register({
            id: "workspace.openCommandPalette",
            title: "Abrir paleta de comandos",
            description: "Buscar comandos",
            category: "General",
            defaultShortcut: "Ctrl+Shift+P",
            contexts: ["global"],
            editable: true,
            handler,
        });
        expect(registry.metadata()[0]).toMatchObject({ id: "workspace.openCommandPalette", title: "Abrir paleta de comandos" });
        await expect(registry.execute("workspace.openCommandPalette")).resolves.toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("rejects duplicate command ids", () => {
        const registry = new CommandRegistry();
        const command = {
            id: "x",
            title: "X",
            description: "",
            category: "Test",
            contexts: ["global" as const],
            editable: true,
            handler: () => true,
        };
        registry.register(command);
        expect(() => registry.register(command)).toThrow("Command already registered");
    });
});
