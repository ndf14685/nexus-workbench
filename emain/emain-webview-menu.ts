// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";

function truncate(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildWebviewContextMenuTemplate(
    params: Electron.ContextMenuParams,
    wc: Electron.WebContents
): Electron.MenuItemConstructorOptions[] {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL) {
        items.push({
            label: "Copy Link Address",
            click: () => electron.clipboard.writeText(params.linkURL),
        });
    }
    if (params.isEditable) {
        items.push(
            { label: "Undo", enabled: params.editFlags.canUndo, click: () => wc.undo() },
            { label: "Redo", enabled: params.editFlags.canRedo, click: () => wc.redo() },
            { type: "separator" },
            { label: "Cut", enabled: params.editFlags.canCut, click: () => wc.cut() },
            { label: "Copy", enabled: params.editFlags.canCopy, click: () => wc.copy() },
            { label: "Paste", enabled: params.editFlags.canPaste, click: () => wc.paste() }
        );
    } else if (params.selectionText) {
        items.push({
            label: `Copy "${truncate(params.selectionText, 24)}"`,
            enabled: params.editFlags.canCopy,
            click: () => wc.copy(),
        });
    }
    if (params.editFlags.canSelectAll) {
        if (items.length > 0) {
            items.push({ type: "separator" });
        }
        items.push({ label: "Select All", click: () => wc.selectAll() });
    }
    return items;
}

export function installWebviewContextMenu(wc: Electron.WebContents) {
    wc.on("context-menu", (_event, params) => {
        // images keep their own menu, raised from preload-webview.ts
        if (params.mediaType === "image") {
            return;
        }
        const template = buildWebviewContextMenuTemplate(params, wc);
        if (template.length === 0) {
            return;
        }
        electron.Menu.buildFromTemplate(template).popup();
    });
}
