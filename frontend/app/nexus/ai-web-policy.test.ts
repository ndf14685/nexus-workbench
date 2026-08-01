// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { aiPermissionDecision, authWindowWebPreferences, isAuthUrl, isHttpUrl, popupAction } from "./ai-web-policy";

describe("isHttpUrl", () => {
    it("acepta http y https", () => {
        expect(isHttpUrl("https://chatgpt.com/")).toBe(true);
        expect(isHttpUrl("http://localhost:3000/")).toBe(true);
    });

    it("rechaza esquemas que no son web", () => {
        for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ws://x", "", "no-url"]) {
            expect(isHttpUrl(url)).toBe(false);
        }
    });
});

describe("isAuthUrl", () => {
    it("reconoce los IdP más usados", () => {
        expect(isAuthUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true);
        expect(isAuthUrl("https://login.microsoftonline.com/common/oauth2/authorize")).toBe(true);
        expect(isAuthUrl("https://appleid.apple.com/auth/authorize")).toBe(true);
        expect(isAuthUrl("https://github.com/login/oauth/authorize")).toBe(true);
        expect(isAuthUrl("https://tenant.okta.com/")).toBe(true);
    });

    it("reconoce subdominios de identidad y flujos OAuth reales", () => {
        expect(isAuthUrl("https://auth.openai.com/authorize")).toBe(true);
        expect(isAuthUrl("https://login.empresa.com.ar/")).toBe(true);
        expect(isAuthUrl("https://ejemplo.com/oauth2/authorize?client_id=x&redirect_uri=y")).toBe(true);
        expect(isAuthUrl("https://ejemplo.com/api/auth/callback?code=abc&state=xyz")).toBe(true);
    });

    it("no confunde contenido normal con un login", () => {
        expect(isAuthUrl("https://chatgpt.com/c/abc-123")).toBe(false);
        // una ruta que se llama /auth sin parámetros de OAuth es contenido
        expect(isAuthUrl("https://es.wikipedia.org/wiki/OAuth")).toBe(false);
        expect(isAuthUrl("https://ejemplo.com/docs/login")).toBe(false);
        expect(isAuthUrl("file:///tmp/login")).toBe(false);
    });
});

describe("popupAction", () => {
    it("los esquemas no-web no se abren en ningún lado", () => {
        expect(popupAction({ url: "file:///etc/passwd" }, { isAiSession: true })).toBe("deny");
        expect(popupAction({ url: "javascript:alert(1)" }, { isAiSession: true })).toBe("deny");
    });

    it("fuera de los paneles de IA se conserva el comportamiento actual", () => {
        expect(
            popupAction(
                { url: "https://accounts.google.com/o/oauth2", disposition: "new-window" },
                { isAiSession: false }
            )
        ).toBe("external");
    });

    it("un window.open con features (popup de login) se atiende dentro de la app", () => {
        expect(popupAction({ url: "https://ejemplo.com/x", disposition: "new-window" }, { isAiSession: true })).toBe(
            "popup"
        );
    });

    it("una URL de identidad se atiende dentro de la app aunque venga como pestaña", () => {
        expect(
            popupAction(
                { url: "https://accounts.google.com/signin", disposition: "foreground-tab" },
                { isAiSession: true }
            )
        ).toBe("popup");
    });

    it("un link común del chat sigue yendo al navegador externo", () => {
        expect(
            popupAction(
                { url: "https://es.wikipedia.org/wiki/Electron", disposition: "foreground-tab" },
                { isAiSession: true }
            )
        ).toBe("external");
    });
});

describe("aiPermissionDecision", () => {
    it("niega todo lo que toca el sistema o la privacidad", () => {
        for (const p of [
            "geolocation",
            "notifications",
            "midi",
            "midiSysex",
            "usb",
            "serial",
            "hid",
            "display-capture",
            "idle-detection",
            "pointerLock",
            "openExternal",
            "clipboard-read",
            "window-management",
            "fileSystem",
            "keyboardLock",
            "unknown",
        ]) {
            expect(aiPermissionDecision(p)).toBe(false);
        }
    });

    it("permite lo mínimo que un chat necesita", () => {
        expect(aiPermissionDecision("clipboard-sanitized-write")).toBe(true);
        expect(aiPermissionDecision("fullscreen")).toBe(true);
        expect(aiPermissionDecision("storage-access")).toBe(true);
    });

    it("micrófono sí, cámara no", () => {
        expect(aiPermissionDecision("media", { mediaTypes: ["audio"] })).toBe(true);
        expect(aiPermissionDecision("media", { mediaType: "audio" })).toBe(true);
        expect(aiPermissionDecision("media", { mediaTypes: ["video"] })).toBe(false);
        expect(aiPermissionDecision("media", { mediaTypes: ["audio", "video"] })).toBe(false);
    });

    it("sin datos de media no se adivina: se niega", () => {
        expect(aiPermissionDecision("media")).toBe(false);
        expect(aiPermissionDecision("media", { mediaTypes: [] })).toBe(false);
    });
});

describe("authWindowWebPreferences", () => {
    it("la ventana de login no tiene Node, ni puente, ni webview anidado", () => {
        const prefs = authWindowWebPreferences("persist:ai-chatgpt");
        expect(prefs.partition).toBe("persist:ai-chatgpt");
        expect(prefs.nodeIntegration).toBe(false);
        expect(prefs.nodeIntegrationInSubFrames).toBe(false);
        expect(prefs.contextIsolation).toBe(true);
        expect(prefs.sandbox).toBe(true);
        expect(prefs.webviewTag).toBe(false);
        expect(prefs.preload).toBeUndefined();
    });
});
