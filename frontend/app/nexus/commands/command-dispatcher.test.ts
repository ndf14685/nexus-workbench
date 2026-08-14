// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { adaptFromElectronKeyEvent, checkKeyPressed, setKeyUtilPlatform } from "@/util/keyutil";
import { getRegisteredShortcutKeys } from "./command-dispatcher";

function electronKeyDown(key: string, mods: { control?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }) {
    return adaptFromElectronKeyEvent({
        type: "keyDown",
        key,
        code: key.length == 1 ? `Key${key.toUpperCase()}` : key,
        control: !!mods.control,
        alt: !!mods.alt,
        shift: !!mods.shift,
        meta: !!mods.meta,
        isAutoRepeat: false,
        location: 0,
    });
}

describe("global webview key registration", () => {
    it("does not steal the parts of a chord from the embedded page", () => {
        const keys = getRegisteredShortcutKeys();
        expect(keys).not.toContain("Ctrl:K");
        expect(keys).not.toContain("Ctrl:S");
    });

    it("still registers single-key shortcuts", () => {
        const keys = getRegisteredShortcutKeys();
        expect(keys).toContain("Ctrl:Alt:g");
        expect(keys).toContain("Ctrl:Shift:p");
    });

    // keyutil infers Shift from an upper-case letter, so "Ctrl:Alt:J" would
    // require Ctrl+Alt+Shift+J and main would never reinject the shortcut
    it("emits descriptors that keyutil actually matches against the raw key event", () => {
        setKeyUtilPlatform("win32");
        const keys = getRegisteredShortcutKeys();
        const ctrlAltJ = electronKeyDown("j", { control: true, alt: true });
        expect(keys.some((desc) => checkKeyPressed(ctrlAltJ, desc))).toBe(true);
        const ctrlShiftP = electronKeyDown("P", { control: true, shift: true });
        expect(keys.some((desc) => checkKeyPressed(ctrlShiftP, desc))).toBe(true);
    });
});
