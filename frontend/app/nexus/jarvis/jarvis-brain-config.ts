// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Resolución del endpoint del cerebro (ADR-0007, "Configuración cero"). Módulo
// PURO: sin Wave, sin Electron, sin jotai. La precedencia vive en un solo lugar
// y se puede discutir/testear sin levantar el Workbench.

// jarvisd sin token bindea SOLO en loopback y no exige auth, así que el caso
// "cerebro y Workbench en la misma máquina" — el abrumadoramente común —
// funciona sin escribir un solo setting.
export const DefaultBrainUrl = "http://127.0.0.1:8770";

export type JarvisBrainSettings = {
    enabled?: boolean;
    url?: string;
    token?: string;
};

// Lo que emain expone del ambiente: NEXUS_DESKTOP_BRAIN_URL / NEXUS_BRAIN_TOKEN,
// las variables que el proyecto Jarvis ya usa.
export type JarvisBrainEnv = {
    url?: string;
    token?: string;
};

// mode "mock" es la ÚNICA puerta al MockJarvisRuntime y solo se abre si el
// usuario apaga el cerebro. Un cerebro configurado pero inalcanzable no cae en
// mock: cae en "cerebro no conectado" (honestidad de superficie, ADR-0007 §5).
export type JarvisBrainConfig = {
    mode: "http" | "mock";
    url: string;
    token: string;
};

function clean(value: string): string {
    return (value ?? "").trim();
}

// Precedencia: setting > env > default.
export function resolveBrainConfig(settings: JarvisBrainSettings, env: JarvisBrainEnv): JarvisBrainConfig {
    if (settings?.enabled === false) {
        return { mode: "mock", url: "", token: "" };
    }
    const url = clean(settings?.url) || clean(env?.url) || DefaultBrainUrl;
    const token = clean(settings?.token) || clean(env?.token);
    return { mode: "http", url, token };
}

// Gobierna si hay que reconstruir el runtime: sin esto, cada push de settings
// del watcher tiraría abajo el SSE y lo reconectaría sin motivo.
export function sameBrainConfig(a: JarvisBrainConfig, b: JarvisBrainConfig): boolean {
    if (a == null || b == null) {
        return a == b;
    }
    return a.mode === b.mode && a.url === b.url && a.token === b.token;
}
