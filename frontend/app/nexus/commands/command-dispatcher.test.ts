// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "vitest";
import { initGlobalAtoms } from "@/app/store/global-atoms";
import { modalsModel } from "@/app/store/modalmodel";
import {
    adaptFromElectronKeyEvent,
    adaptFromReactOrNativeKeyEvent,
    checkKeyPressed,
    setKeyUtilPlatform,
} from "@/util/keyutil";
import { dispatchWorkbenchCommandShortcut, getRegisteredShortcutKeys } from "./command-dispatcher";

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

describe("dispatch from terminal focus", () => {
    beforeAll(() => {
        initGlobalAtoms({ tabId: "tab-test", windowId: "win-test" } as GlobalInitOptions);
    });

    // xterm's real input element is a hidden TEXTAREA; the terminal path calls the
    // dispatcher without a target on purpose so the shortcut is not vetoed
    it("dispatches even when the native event comes from xterm's textarea", () => {
        setKeyUtilPlatform("win32");
        modalsModel.pushModal("MessageModal", {});
        try {
            const fakeXtermTextarea = { tagName: "TEXTAREA", closest: () => null };
            const nativeEvent = {
                type: "keydown",
                key: " ",
                code: "Space",
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                location: 0,
                target: fakeXtermTextarea,
            } as unknown as KeyboardEvent;
            const waveEvent = adaptFromReactOrNativeKeyEvent(nativeEvent);
            expect(dispatchWorkbenchCommandShortcut(waveEvent)).toBe(true);
        } finally {
            while (modalsModel.hasOpenModals()) {
                modalsModel.popModal();
            }
        }
    });

    it("still vetoes shortcuts when the caller passes a real input target", () => {
        setKeyUtilPlatform("win32");
        modalsModel.pushModal("MessageModal", {});
        try {
            const inputTarget = { tagName: "INPUT", closest: () => null } as unknown as EventTarget;
            const nativeEvent = {
                type: "keydown",
                key: " ",
                code: "Space",
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                metaKey: false,
                location: 0,
                target: inputTarget,
            } as unknown as KeyboardEvent;
            const waveEvent = adaptFromReactOrNativeKeyEvent(nativeEvent);
            expect(dispatchWorkbenchCommandShortcut(waveEvent, inputTarget)).toBe(false);
        } finally {
            while (modalsModel.hasOpenModals()) {
                modalsModel.popModal();
            }
        }
    });
});

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
