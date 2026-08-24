// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Modelo compartido de las fuentes visuales en el renderer. El contrato es el
// mismo que el del provider del host (nexus/mcp/visualsource.go): una fuente se
// configura una vez y la ven tanto el viewer humano como el observador IA, que
// son permisos distintos.

import { getSettingsKeyAtom } from "@/app/store/global";
import { atom } from "jotai";

export type VisualSourceType = "uvc" | "desktop" | "window" | "remote" | "virtual";

// Ver la señal NO implica que la IA pueda mirarla. `off` es off aunque el bloque
// esté abierto y en primer plano.
export type AIVisionMode = "off" | "on_demand" | "changes";

// Taxonomía de errores compartida con el provider (§17). El bloque los muestra
// sin caerse: un error de la capturadora nunca tumba el Workbench.
export type VisualErrorCode =
    | "NO_DEVICE"
    | "DEVICE_BUSY"
    | "PERMISSION_DENIED"
    | "STREAM_FAILED"
    | "DEVICE_REMOVED"
    | "UNSUPPORTED_FORMAT"
    | "RECONNECTING";

export interface VisualDeviceSelector {
    hardwareid?: string;
    name?: string;
    vid?: string;
    pid?: string;
    path?: string;
    // deviceid: el id que devuelve enumerateDevices() en ESTE origen. Es estable
    // por perfil pero no sobrevive a un borrado de datos del sitio, así que se
    // usa como atajo y nunca como única clave.
    deviceid?: string;
}

export interface VisualAudioSelector {
    name?: string;
    hardwareid?: string;
    enabled?: boolean;
}

export interface VisualSourceConfig {
    id: string;
    type?: VisualSourceType;
    label?: string;
    device?: VisualDeviceSelector;
    audio?: VisualAudioSelector;
    aivision?: AIVisionMode;
    width?: number;
    height?: number;
    fps?: number;
}

export const VisualSourcesSettingsKey = "nexus:visualsources";

// Default explícito: on_demand. Nunca `continuous`, y `off` sólo si la fuente lo
// declara. Un valor desconocido en config no habilita nada raro.
export function normalizeAIVision(mode: string | undefined): AIVisionMode {
    switch ((mode ?? "").trim().toLowerCase()) {
        case "off":
            return "off";
        case "changes":
            return "changes";
        default:
            return "on_demand";
    }
}

export function sourceLabel(src: VisualSourceConfig): string {
    return src.label?.trim() || src.id;
}

// visualSourcesAtom: las fuentes viven en settings.json bajo `nexus:visualsources`,
// igual que `nexus:environments`. Se editan desde Settings y persisten solas.
export const visualSourcesAtom = atom((get) => {
    const raw = get(getSettingsKeyAtom(VisualSourcesSettingsKey)) as VisualSourceConfig[] | undefined;
    if (!Array.isArray(raw)) {
        return [] as VisualSourceConfig[];
    }
    // Una fuente sin id no es direccionable: se ignora en vez de romper la lista.
    return raw.filter((src) => typeof src?.id === "string" && src.id.trim() !== "");
});

export function findSource(sources: VisualSourceConfig[], id: string): VisualSourceConfig | null {
    return sources.find((src) => src.id === id) ?? null;
}

// La fuente por defecto del botón HMI: la primera configurada. Con una sola
// fuente (el caso real) esto es exactamente lo que el usuario espera.
export function defaultSourceId(sources: VisualSourceConfig[]): string | null {
    return sources.length > 0 ? sources[0].id : null;
}

export function describeVisualError(code: VisualErrorCode, detail?: string): string {
    switch (code) {
        case "NO_DEVICE":
            return "No se encuentra el dispositivo configurado para esta fuente.";
        case "DEVICE_REMOVED":
            return "El dispositivo se desconectó.";
        case "DEVICE_BUSY":
            return "Otro programa está usando la capturadora.";
        case "PERMISSION_DENIED":
            return "El Workbench no tiene permiso de cámara. Configuración > Privacidad y permisos.";
        case "UNSUPPORTED_FORMAT":
            return "El dispositivo no soporta el formato pedido.";
        case "RECONNECTING":
            return "Reconectando…";
        default:
            return detail?.trim() || "No se pudo abrir la señal.";
    }
}
