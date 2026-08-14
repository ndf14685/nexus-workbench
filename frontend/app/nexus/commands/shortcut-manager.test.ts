// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "./command-types";
import { ShortcutManager, normalizeShortcut, shouldIgnoreShortcutTarget } from "./shortcut-manager";

function memoryStorage(initial = "{}") {
    let value = initial;
    return {
        getItem: () => value,
        setItem: (_key: string, next: string) => (value = next),
        removeItem: () => (value = "{}"),
    };
}

const commands: CommandDefinition[] = [
    { id: "a", title: "A", description: "", category: "T", defaultShortcut: "Ctrl+Shift+P", contexts: ["global"], editable: true, handler: () => true },
    { id: "b", title: "B", description: "", category: "T", defaultShortcut: "Ctrl+Shift+P", contexts: ["terminal"], editable: true, handler: () => true },
    { id: "c", title: "C", description: "", category: "T", defaultShortcut: "Ctrl+K Ctrl+S", contexts: ["global"], editable: true, handler: () => true },
];

describe("ShortcutManager", () => {
    it("normalizes shortcuts", () => {
        expect(normalizeShortcut("ctrl+shift+p")).toBe("Ctrl+Shift+P");
        expect(normalizeShortcut("Ctrl+K Ctrl+S")).toBe("Ctrl+K Ctrl+S");
    });

    it("detects conflicts", () => {
        expect(new ShortcutManager(memoryStorage()).findConflicts(commands)).toEqual([{ shortcut: "Ctrl+Shift+P", commandIds: ["a", "b"] }]);
    });

    it("matches by context and executes chords", () => {
        const mgr = new ShortcutManager(memoryStorage());
        expect(mgr.match({ control: true, shift: true, key: "P" } as WaveKeyboardEvent, commands, "global")?.id).toBe("a");
        expect(mgr.match({ control: true, key: "K" } as WaveKeyboardEvent, commands, "global")).toBeNull();
        expect(mgr.match({ control: true, key: "S" } as WaveKeyboardEvent, commands, "global")?.id).toBe("c");
    });

    it("persists customizations and tolerates invalid config", () => {
        const storage = memoryStorage("{bad");
        const mgr = new ShortcutManager(storage);
        mgr.setShortcut("a", "Ctrl+Alt+A");
        expect(new ShortcutManager(storage).exportConfig()).toEqual({ a: "Ctrl+Alt+A" });
    });

    it("does not interfere with inputs and textareas", () => {
        const input = { tagName: "INPUT" } as HTMLElement;
        const text = { tagName: "TEXTAREA" } as HTMLElement;
        expect(shouldIgnoreShortcutTarget(input)).toBe(true);
        expect(shouldIgnoreShortcutTarget(text)).toBe(true);
    });
    it("notifies change listeners when the config mutates", () => {
        const mgr = new ShortcutManager(memoryStorage());
        let fired = 0;
        mgr.onChange(() => fired++);
        mgr.setShortcut("a", "Ctrl+Alt+Q");
        mgr.resetShortcut("a");
        mgr.importConfig({ a: "Ctrl+Alt+Q" });
        expect(fired).toBe(3);
    });
});
