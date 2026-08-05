// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { closeDevToolsSafely, isDevToolsOpenSafely, toggleDevToolsSafely } from "./webview-devtools";

// Un <webview> cuyo guest ya fue destruido: los métodos tiran en vez de
// devolver algo. Es lo que pasa cuando React sacó el elemento del DOM.
function detachedWebview() {
    const err = () => {
        throw new Error("Invalid guestInstanceId: 7");
    };
    return { isDevToolsOpened: err, closeDevTools: err, openDevTools: err } as any;
}

function liveWebview(open: boolean) {
    return {
        isDevToolsOpened: vi.fn(() => open),
        closeDevTools: vi.fn(),
        openDevTools: vi.fn(),
    } as any;
}

describe("devtools de un webview desmontado", () => {
    // El cleanup corre dentro del commit de borrado de React: si tira, aborta
    // el desmontaje del árbol y el error sale a la app entera.
    it("no propaga cuando el guest ya no existe", () => {
        expect(() => closeDevToolsSafely(detachedWebview())).not.toThrow();
        expect(() => toggleDevToolsSafely(detachedWebview())).not.toThrow();
        expect(isDevToolsOpenSafely(detachedWebview())).toBe(false);
    });

    it("tolera una ref nula", () => {
        expect(() => closeDevToolsSafely(null)).not.toThrow();
        expect(() => toggleDevToolsSafely(undefined)).not.toThrow();
        expect(isDevToolsOpenSafely(null)).toBe(false);
    });

    it("sigue cerrando las devtools cuando el webview está vivo", () => {
        const webview = liveWebview(true);
        closeDevToolsSafely(webview);
        expect(webview.closeDevTools).toHaveBeenCalled();
    });

    it("no cierra nada si no estaban abiertas", () => {
        const webview = liveWebview(false);
        closeDevToolsSafely(webview);
        expect(webview.closeDevTools).not.toHaveBeenCalled();
    });

    it("alterna abrir y cerrar según el estado real", () => {
        const closed = liveWebview(false);
        toggleDevToolsSafely(closed);
        expect(closed.openDevTools).toHaveBeenCalled();

        const open = liveWebview(true);
        toggleDevToolsSafely(open);
        expect(open.closeDevTools).toHaveBeenCalled();
    });

    it("reporta el estado de un webview vivo", () => {
        expect(isDevToolsOpenSafely(liveWebview(true))).toBe(true);
        expect(isDevToolsOpenSafely(liveWebview(false))).toBe(false);
    });
});
