// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Sesiones de los chats web de IA (D-031).
//
// Qué resuelve este archivo:
//
//   - PERSISTENCIA: una partición `persist:ai-<proveedor>` por proveedor. Es el
//     mecanismo propio de Chromium/Electron: cookies, localStorage e IndexedDB
//     quedan en el data dir de la app y sobreviven al reinicio. No se guarda —
//     ni se inyecta— ninguna credencial en archivos de configuración.
//   - PERMISOS: la política de ai-web-policy.ts aplicada a esas sesiones. Todo
//     lo que no necesita un chat se niega.
//   - LOGIN: los window.open de un login se atienden con una ventana emergente
//     controlada, en la MISMA partición, para que la sesión resultante quede
//     donde el panel la va a leer. El resto de los links sigue yendo al
//     navegador externo.
//
// La página remota nunca recibe un puente al sistema: los <webview> corren sin
// Node y con aislamiento de contexto (ver hardenWebviewPreferences).

import { AI_WEB_APPS, aiPartition, isAiPartition } from "@/app/nexus/ai-apps";
import {
    aiPermissionDecision,
    authWindowWebPreferences,
    isHttpUrl,
    popupAction,
    type PopupDetails,
} from "@/app/nexus/ai-web-policy";
import * as electron from "electron";

// session → nombre de partición. Electron no expone la partición de un
// webContents, y la necesitamos para reconocer un guest de IA cuando se attachea.
const aiSessions = new Map<Electron.Session, string>();

export function hardenAiSession(partition: string): Electron.Session | null {
    if (!isAiPartition(partition)) {
        return null;
    }
    const sess = electron.session.fromPartition(partition);
    if (aiSessions.has(sess)) {
        return sess;
    }
    aiSessions.set(sess, partition);

    sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
        const allowed = aiPermissionDecision(permission, details as any);
        if (!allowed) {
            console.log(`[aiweb] permiso denegado ${permission} en ${partition}`);
        }
        callback(allowed);
    });
    sess.setPermissionCheckHandler((_wc, permission, _origin, details) => {
        return aiPermissionDecision(permission, details as any);
    });
    // Ningún dispositivo físico (USB/serial/HID) para una página remota.
    sess.setDevicePermissionHandler(() => false);

    // Verificación de certificados: se delega SIEMPRE en Chromium (-3 = usar el
    // resultado por defecto). Está escrito explícitamente para que quede
    // registrado que un certificado inválido no se acepta en silencio; el
    // handler existe solo para loguear el rechazo.
    sess.setCertificateVerifyProc((request, callback) => {
        if (request.errorCode !== 0) {
            console.log(`[aiweb] certificado rechazado ${request.hostname} err=${request.errorCode}`);
        }
        callback(-3);
    });

    console.log(`[aiweb] sesión persistente lista: ${partition}`);
    return sess;
}

// Las particiones del catálogo se preparan al arrancar, antes de que exista
// ningún bloque: así ningún panel llega a cargar sin política aplicada.
export function initAiSessions() {
    for (const app of Object.values(AI_WEB_APPS)) {
        hardenAiSession(aiPartition(app.id));
    }
}

export function isAiWebContents(wc: Electron.WebContents): boolean {
    try {
        return wc != null && !wc.isDestroyed() && aiSessions.has(wc.session);
    } catch {
        return false;
    }
}

export function attachAuthWindowGuards(win: Electron.BrowserWindow, partition: string) {
    win.setMenuBarVisibility(false);
    const wc = win.webContents;
    // Navegación: solo web. Un esquema externo (mailto:, custom protocol de una
    // app instalada) no se sigue desde una ventana de login.
    wc.on("will-navigate", (event, url) => {
        if (!isHttpUrl(url)) {
            console.log("[aiweb] navegación bloqueada en ventana de login:", url);
            event.preventDefault();
        }
    });
    // Un login puede encadenar otra emergente (MFA, passkey): se permite, con
    // las mismas restricciones y en la misma partición.
    wc.setWindowOpenHandler((details) => {
        if (!isHttpUrl(details.url)) {
            return { action: "deny" };
        }
        return {
            action: "allow",
            overrideBrowserWindowOptions: {
                width: 600,
                height: 760,
                autoHideMenuBar: true,
                webPreferences: authWindowWebPreferences(partition),
            },
        };
    });
    wc.on("did-create-window", (child) => attachAuthWindowGuards(child, partition));
}

/**
 * Ventana emergente de login: mismo partition que el panel, sin Node, sin
 * preload. Se usa cuando el panel dispara un window.open que la política
 * clasifica como "popup" (ver popupAction).
 */
export function openAiAuthWindow(url: string, partition: string, parent?: Electron.BrowserWindow) {
    if (!isHttpUrl(url) || !isAiPartition(partition)) {
        console.log("[aiweb] ventana de login rechazada", url, partition);
        return null;
    }
    hardenAiSession(partition);
    const win = new electron.BrowserWindow({
        width: 600,
        height: 760,
        parent,
        autoHideMenuBar: true,
        title: "Nexus Workbench — inicio de sesión",
        webPreferences: authWindowWebPreferences(partition),
    });
    attachAuthWindowGuards(win, partition);
    win.loadURL(url);
    return win;
}

/**
 * Handler de window.open de un <webview>.
 *
 * - "popup": Electron crea la ventana Y conserva la relación con su opener, que
 *   es lo que necesitan los flujos OAuth que hacen postMessage al abridor. Va
 *   con los webPreferences endurecidos y hereda la partición del panel.
 * - "external": se invoca `onExternal` (el llamador decide: navegador del
 *   sistema o bloque web) y se deniega la ventana.
 * - "deny": esquema no-web, no se abre en ningún lado.
 */
export function handleWebviewWindowOpen(
    guest: Electron.WebContents,
    details: PopupDetails,
    onExternal: () => void
): Electron.WindowOpenHandlerResponse {
    const partition = aiSessions.get(guest?.session);
    const decision = popupAction(details, { isAiSession: partition != null });
    if (decision === "popup") {
        console.log("[aiweb] ventana de login dentro de la app:", details.url);
        return {
            action: "allow",
            overrideBrowserWindowOptions: {
                width: 600,
                height: 760,
                autoHideMenuBar: true,
                webPreferences: authWindowWebPreferences(partition),
            },
        };
    }
    if (decision === "external") {
        onExternal();
    } else {
        console.log("[aiweb] window.open bloqueado (esquema no web):", details.url);
    }
    return { action: "deny" };
}

export function partitionForWebContents(wc: Electron.WebContents): string | null {
    return aiSessions.get(wc?.session) ?? null;
}

/**
 * Endurece los webPreferences de CUALQUIER <webview> antes de que se attachee.
 * Es el cinturón además del tirante: aunque alguien edite el markup del tag, el
 * proceso main no permite Node ni desactivar el aislamiento en una página
 * remota.
 */
export function hardenWebviewPreferences(params: Electron.WebPreferences & { preload?: string }) {
    params.nodeIntegration = false;
    params.nodeIntegrationInSubFrames = false;
    params.contextIsolation = true;
    params.webSecurity = true;
    params.allowRunningInsecureContent = false;
    params.experimentalFeatures = false;
}
