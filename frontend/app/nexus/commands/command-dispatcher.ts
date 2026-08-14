// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { atoms, getFocusedBlockId, globalStore, WOS } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import type { CommandContext } from "./command-types";
import { commandRegistry } from "./command-registry";
import { registerWorkbenchCommands } from "./workbench-commands";
import { shortcutManager, shouldIgnoreShortcutTarget } from "./shortcut-manager";

export function getCommandContext(): CommandContext {
    if (modalsModel.hasOpenModals() || globalStore.get(atoms.modalOpen)) {
        return "modal";
    }
    const blockId = getFocusedBlockId();
    if (!blockId) return "global";
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    switch (block?.meta?.view) {
        case "term":
            return "terminal";
        case "web":
            return "browser";
        case "waveconfig":
            return "settings";
        default:
            return "global";
    }
}

export function dispatchWorkbenchCommandShortcut(waveEvent: WaveKeyboardEvent, target?: EventTarget | null): boolean {
    registerWorkbenchCommands();
    if (shouldIgnoreShortcutTarget(target ?? (waveEvent as any).nativeEvent?.target)) {
        return false;
    }
    const command = shortcutManager.match(waveEvent, commandRegistry.list(), getCommandContext());
    if (!command) {
        return false;
    }
    void commandRegistry.execute(command.id).then((ok) => {
        if (!ok) {
            modalsModel.pushModal("MessageModal", { children: `No se pudo ejecutar: ${command.title}` });
        }
    });
    return true;
}

// keyutil.parseKeyDescription infers Shift from an upper-case letter, so the final
// key must go out lower-case ("Ctrl:Alt:j") or main would require Shift and never
// reinject the shortcut from an embedded webview
function toWaveKeyDescriptor(shortcut: string): string {
    const parts = shortcut.split("+");
    const key = parts[parts.length - 1];
    if (key.length == 1) {
        parts[parts.length - 1] = key == " " ? "Space" : key.toLowerCase();
    }
    return parts.join(":");
}

export function getRegisteredShortcutKeys(): string[] {
    registerWorkbenchCommands();
    // chords are left out on purpose: registering their parts would swallow a bare Ctrl+K or Ctrl+S
    // from the embedded page, and ChatGPT binds Ctrl+K itself
    return commandRegistry
        .list()
        .map((cmd) => shortcutManager.getShortcut(cmd))
        .filter((shortcut) => shortcut && !/\s/.test(shortcut))
        .map(toWaveKeyDescriptor);
}
