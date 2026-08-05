// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    clipboard: { writeText: vi.fn() },
    Menu: { buildFromTemplate: vi.fn() },
}));

import { buildWebviewContextMenuTemplate } from "./emain-webview-menu";

const editFlags = {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canSelectAll: true,
    canDelete: false,
    canEditRichly: false,
};

function params(overrides: any) {
    return { linkURL: "", selectionText: "", isEditable: false, mediaType: "none", editFlags, ...overrides } as any;
}

describe("webview context menu", () => {
    const wc = { copy: vi.fn(), paste: vi.fn(), cut: vi.fn(), undo: vi.fn(), redo: vi.fn(), selectAll: vi.fn() } as any;

    it("offers copy for selected text on a page", () => {
        const template = buildWebviewContextMenuTemplate(
            params({ selectionText: "hola mundo", editFlags: { ...editFlags, canCopy: true } }),
            wc
        );
        const copy = template.find((item) => String(item.label).startsWith("Copy"));
        expect(copy).toBeDefined();
        expect(copy.enabled).toBe(true);
        copy.click(null as any, null as any, null as any);
        expect(wc.copy).toHaveBeenCalled();
    });

    it("offers paste inside an editable field", () => {
        const template = buildWebviewContextMenuTemplate(
            params({ isEditable: true, editFlags: { ...editFlags, canPaste: true } }),
            wc
        );
        expect(template.find((item) => item.label === "Paste")?.enabled).toBe(true);
    });

    it("offers the link address on a link", () => {
        const template = buildWebviewContextMenuTemplate(params({ linkURL: "https://example.com/" }), wc);
        expect(template[0].label).toBe("Copy Link Address");
    });

    it("shortens a long selection in the label", () => {
        const template = buildWebviewContextMenuTemplate(
            params({ selectionText: "x".repeat(200), editFlags: { ...editFlags, canCopy: true } }),
            wc
        );
        expect(String(template[0].label).length).toBeLessThan(40);
    });
});
