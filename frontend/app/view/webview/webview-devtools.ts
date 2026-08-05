// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { WebviewTag } from "electron";

// El guest de un <webview> se destruye cuando el elemento sale del DOM, y eso
// ocurre ANTES de que corra el cleanup del efecto que lo referencia: ahí la ref
// sigue apuntando al elemento pero cualquier método del guest tira
// "Invalid guestInstanceId". Como ese cleanup corre dentro del commit de
// borrado de React, un throw aborta el desmontaje del árbol y el error escapa
// a la aplicación entera en vez de quedar en un warning.

type MaybeWebview = WebviewTag | null | undefined;

export function isDevToolsOpenSafely(webview: MaybeWebview): boolean {
    if (webview == null) {
        return false;
    }
    try {
        return webview.isDevToolsOpened();
    } catch {
        return false;
    }
}

export function closeDevToolsSafely(webview: MaybeWebview) {
    if (!isDevToolsOpenSafely(webview)) {
        return;
    }
    try {
        webview.closeDevTools();
    } catch {
        // el guest se destruyó entre la consulta y el cierre
    }
}

export function toggleDevToolsSafely(webview: MaybeWebview) {
    if (webview == null) {
        return;
    }
    if (isDevToolsOpenSafely(webview)) {
        closeDevToolsSafely(webview);
        return;
    }
    try {
        webview.openDevTools();
    } catch {
        // sin guest no hay devtools que abrir
    }
}
