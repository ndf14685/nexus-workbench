// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Política de seguridad de los módulos web de IA (D-031).
//
// Vive acá, separada de Electron, para que sea testeable sin levantar la app:
// `emain/emain-aiweb.ts` la aplica sobre la sesión/partición real. Un chat web
// es una interfaz visual: no obtiene acceso al sistema local por el solo hecho
// de estar cargado dentro del Workbench.

export function isHttpUrl(url: string): boolean {
    try {
        const proto = new URL(url).protocol;
        return proto === "https:" || proto === "http:";
    } catch {
        return false;
    }
}

// Hosts de identidad conocidos. No es una allowlist de navegación (el usuario
// puede loguearse con cualquier IdP): es la señal de "esto es un login" para
// decidir que la ventana emergente se atiende DENTRO de la app, con la misma
// partición, en vez de mandarla al navegador externo donde la sesión se pierde.
const AuthHostSuffixes = [
    "accounts.google.com",
    "accounts.youtube.com",
    "login.microsoftonline.com",
    "login.live.com",
    "login.microsoft.com",
    "appleid.apple.com",
    "github.com",
    "auth0.com",
    "okta.com",
    "oktapreview.com",
    "duosecurity.com",
    "auth.openai.com",
    "auth.anthropic.com",
    "accounts.anthropic.com",
];

// Subdominios dedicados a identidad (auth.proveedor.com, login.empresa.com…).
const AuthHostPrefixes = ["auth.", "accounts.", "account.", "login.", "signin.", "sso.", "oauth.", "idp."];

const AuthPathRe =
    /(^|\/)(oauth2?|openid|auth|authorize|login|signin|sign-in|sso|saml|callback|passkey|webauthn)(\/|$)/i;

// Parámetros que solo aparecen en un flujo OAuth/OIDC real. Sin uno de estos,
// una ruta que se llame "/auth" es probablemente contenido (un artículo, un
// docs), no un login: mejor mandarla al navegador externo que abrir ventanas.
const AuthQueryParams = ["client_id", "redirect_uri", "response_type", "code_challenge", "state", "scope", "code"];

export function isAuthUrl(url: string): boolean {
    if (!isHttpUrl(url)) {
        return false;
    }
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (AuthHostSuffixes.some((suffix) => host === suffix || host.endsWith("." + suffix))) {
        return true;
    }
    if (AuthHostPrefixes.some((prefix) => host.startsWith(prefix))) {
        return true;
    }
    if (!AuthPathRe.test(parsed.pathname)) {
        return false;
    }
    return AuthQueryParams.some((p) => parsed.searchParams.has(p));
}

export type PopupDetails = {
    url: string;
    disposition?: string;
};

export type PopupAction =
    // ventana emergente controlada DENTRO de la app, misma partición: el login
    // termina y la cookie queda donde el panel la va a leer
    | "popup"
    // navegador externo (comportamiento histórico del navegador embebido)
    | "external"
    // ni una cosa ni la otra: esquemas raros no se abren en ningún lado
    | "deny";

/**
 * Qué hacer con un window.open que sale de un panel web.
 *
 * `isAiSession` distingue los chats de IA del resto del navegador embebido: solo
 * ahí se abre una ventana emergente propia, porque solo ahí importa que la
 * sesión resultante quede en la partición del proveedor.
 */
export function popupAction(details: PopupDetails, opts: { isAiSession: boolean }): PopupAction {
    const url = details?.url ?? "";
    if (!isHttpUrl(url)) {
        return "deny";
    }
    if (!opts.isAiSession) {
        return "external";
    }
    if (details.disposition === "new-window" || isAuthUrl(url)) {
        return "popup";
    }
    return "external";
}

// Permisos que un chat web puede pedir. Todo lo que no esté acá se deniega:
// geolocalización, notificaciones, USB/serial/HID, captura de pantalla,
// lectura del portapapeles, detección de inactividad, midi, etc.
const AllowedPermissions = new Set([
    "clipboard-sanitized-write", // copiar una respuesta
    "fullscreen",
    "storage-access", // cookies de terceros durante un login federado
    "top-level-storage-access",
    "media", // solo audio — ver abajo
]);

export type PermissionDetails = {
    mediaTypes?: string[];
    mediaType?: string;
};

/**
 * `media` es el único permiso con matiz: se concede el MICRÓFONO (dictado de
 * ChatGPT/Claude) y se niega la cámara, que ningún chat necesita.
 */
export function aiPermissionDecision(permission: string, details?: PermissionDetails): boolean {
    if (!AllowedPermissions.has(permission)) {
        return false;
    }
    if (permission !== "media") {
        return true;
    }
    const types = details?.mediaTypes ?? (details?.mediaType ? [details.mediaType] : null);
    if (types == null || types.length === 0) {
        // sin información no se adivina: se niega
        return false;
    }
    return types.every((t) => t === "audio");
}

// webPreferences de cualquier ventana secundaria (login) que abramos: sin Node,
// aislada del contexto de la app y sin poder anidar otro <webview>. La partición
// es la del proveedor, así la sesión que se obtiene es la que el panel usa.
export function authWindowWebPreferences(partition: string) {
    return {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        spellcheck: false,
        // sin preload: la página de login no necesita —ni debe tener— puentes
        preload: undefined as string | undefined,
    };
}
