// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Verificación del proceso main sin levantar Electron: qué política queda
// aplicada sobre las sesiones de los chats web y qué se hace con un window.open.

import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeSession = {
    permissionRequestHandler?: (wc: any, permission: string, cb: (ok: boolean) => void, details?: any) => void;
    permissionCheckHandler?: (wc: any, permission: string, origin: string, details?: any) => boolean;
    devicePermissionHandler?: (details: any) => boolean;
    certificateVerifyProc?: (request: any, cb: (verdict: number) => void) => void;
    setPermissionRequestHandler: (fn: any) => void;
    setPermissionCheckHandler: (fn: any) => void;
    setDevicePermissionHandler: (fn: any) => void;
    setCertificateVerifyProc: (fn: any) => void;
};

const sessions = new Map<string, FakeSession>();

function makeFakeSession(): FakeSession {
    const sess: FakeSession = {
        setPermissionRequestHandler(fn) {
            sess.permissionRequestHandler = fn;
        },
        setPermissionCheckHandler(fn) {
            sess.permissionCheckHandler = fn;
        },
        setDevicePermissionHandler(fn) {
            sess.devicePermissionHandler = fn;
        },
        setCertificateVerifyProc(fn) {
            sess.certificateVerifyProc = fn;
        },
    };
    return sess;
}

vi.mock("electron", () => ({
    session: {
        fromPartition: (partition: string) => {
            if (!sessions.has(partition)) {
                sessions.set(partition, makeFakeSession());
            }
            return sessions.get(partition);
        },
    },
    BrowserWindow: class {},
}));

// vi.mock se iza por encima de los imports, así que este import estático ya ve
// el módulo "electron" falso de arriba.
import {
    handleWebviewWindowOpen,
    hardenAiSession,
    hardenWebviewPreferences,
    initAiSessions,
    partitionForWebContents,
} from "./emain-aiweb";

function guestFor(partition: string) {
    return { session: sessions.get(partition), isDestroyed: () => false } as any;
}

beforeEach(() => {
    initAiSessions();
});

describe("sesiones persistentes de los chats web", () => {
    it("prepara una partición por proveedor del catálogo", () => {
        for (const p of ["persist:ai-chatgpt", "persist:ai-claude", "persist:ai-gemini"]) {
            expect(sessions.has(p)).toBe(true);
        }
    });

    it("ignora particiones que no son de IA (no toca el resto del navegador)", () => {
        expect(hardenAiSession("persist:otracosa")).toBeNull();
        expect(hardenAiSession(undefined as unknown as string)).toBeNull();
    });

    it("deja puesta la política de permisos", () => {
        const sess = sessions.get("persist:ai-chatgpt");
        const decide = (permission: string, details?: any) => {
            let out: boolean = null;
            sess.permissionRequestHandler({}, permission, (ok) => (out = ok), details);
            return out;
        };
        expect(decide("geolocation")).toBe(false);
        expect(decide("notifications")).toBe(false);
        expect(decide("media", { mediaTypes: ["video"] })).toBe(false);
        expect(decide("media", { mediaTypes: ["audio"] })).toBe(true);
        expect(decide("clipboard-sanitized-write")).toBe(true);
        expect(sess.permissionCheckHandler({}, "usb", "https://chatgpt.com", {})).toBe(false);
    });

    it("no concede dispositivos físicos", () => {
        expect(sessions.get("persist:ai-claude").devicePermissionHandler({})).toBe(false);
    });

    it("delega la validación de certificados en Chromium (nunca acepta uno inválido)", () => {
        let verdict: number = null;
        sessions
            .get("persist:ai-claude")
            .certificateVerifyProc({ hostname: "claude.ai", errorCode: -200 }, (v) => (verdict = v));
        // -3 = usar el resultado de la verificación por defecto
        expect(verdict).toBe(-3);
    });
});

describe("window.open de un panel", () => {
    it("un login abre ventana dentro de la app, con la partición del proveedor", () => {
        let external = 0;
        const rtn = handleWebviewWindowOpen(
            guestFor("persist:ai-chatgpt"),
            { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x", disposition: "new-window" },
            () => external++
        );
        expect(rtn.action).toBe("allow");
        expect(external).toBe(0);
        const prefs = (rtn as any).overrideBrowserWindowOptions.webPreferences;
        expect(prefs.partition).toBe("persist:ai-chatgpt");
        expect(prefs.nodeIntegration).toBe(false);
        expect(prefs.contextIsolation).toBe(true);
        expect(prefs.sandbox).toBe(true);
        expect(prefs.webviewTag).toBe(false);
    });

    it("un link común del chat se delega al llamador (navegador externo)", () => {
        let external = 0;
        const rtn = handleWebviewWindowOpen(
            guestFor("persist:ai-claude"),
            { url: "https://es.wikipedia.org/wiki/Electron", disposition: "foreground-tab" },
            () => external++
        );
        expect(rtn.action).toBe("deny");
        expect(external).toBe(1);
    });

    it("un esquema no web no se abre en ningún lado", () => {
        let external = 0;
        const rtn = handleWebviewWindowOpen(
            guestFor("persist:ai-claude"),
            { url: "file:///etc/passwd", disposition: "new-window" },
            () => external++
        );
        expect(rtn.action).toBe("deny");
        expect(external).toBe(0);
    });

    it("un panel web que no es de IA conserva el comportamiento de siempre", () => {
        let external = 0;
        const rtn = handleWebviewWindowOpen(
            { session: makeFakeSession(), isDestroyed: () => false } as any,
            { url: "https://accounts.google.com/o/oauth2", disposition: "new-window" },
            () => external++
        );
        expect(rtn.action).toBe("deny");
        expect(external).toBe(1);
    });
});

describe("endurecimiento de los <webview>", () => {
    it("una página remota nunca recibe Node ni pierde el aislamiento", () => {
        const prefs: any = { nodeIntegration: true, contextIsolation: false, webSecurity: false };
        hardenWebviewPreferences(prefs);
        expect(prefs.nodeIntegration).toBe(false);
        expect(prefs.nodeIntegrationInSubFrames).toBe(false);
        expect(prefs.contextIsolation).toBe(true);
        expect(prefs.webSecurity).toBe(true);
        expect(prefs.allowRunningInsecureContent).toBe(false);
    });

    it("la partición de un guest se resuelve para poder atender su login", () => {
        expect(partitionForWebContents(guestFor("persist:ai-gemini"))).toBe("persist:ai-gemini");
        expect(partitionForWebContents({ session: makeFakeSession() } as any)).toBeNull();
    });
});
