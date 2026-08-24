// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Resolución de una fuente configurada contra los dispositivos que ve el
// renderer (`navigator.mediaDevices.enumerateDevices()`). Funciones puras: toda
// la lógica de "cuál cámara es" se testea sin hardware y sin DOM.
//
// La regla que gobierna este archivo: si el dispositivo configurado no está, NO
// se cae en otra cámara. Abrir la webcam personal del usuario porque la
// capturadora no aparece es peor que mostrar "SOURCE OFFLINE".

import type { VisualDeviceSelector } from "./visual-types";

export interface EnumeratedDevice {
    deviceId: string;
    label: string;
    groupId?: string;
    kind: string;
}

export type DeviceMatchKind = "deviceid" | "hardwareid" | "vidpid" | "name" | "ambiguous_name" | "none";

export interface DeviceMatch {
    device: EnumeratedDevice | null;
    matchedBy: DeviceMatchKind;
}

// Chromium anexa el par vid:pid al label en Windows y Linux:
//   "USB Video (534d:2109)"
// Es la forma más confiable de identificar el hardware desde el renderer,
// porque el nombre solo ("USB Video") lo comparten media docena de capturadoras.
const VidPidRe = /\(([0-9a-f]{4}):([0-9a-f]{4})\)\s*$/i;

export function parseVidPid(label: string): { vid: string; pid: string } | null {
    const m = VidPidRe.exec((label ?? "").trim());
    if (!m) {
        return null;
    }
    return { vid: m[1].toLowerCase(), pid: m[2].toLowerCase() };
}

// El nombre visible sin el sufijo de ids, para comparar contra el `name` de la
// config (que viene del enumerado del host y no lleva el sufijo).
export function baseLabel(label: string): string {
    return (label ?? "").replace(VidPidRe, "").trim();
}

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

export function resolveDevice(sel: VisualDeviceSelector | undefined, devices: EnumeratedDevice[]): DeviceMatch {
    const cams = (devices ?? []).filter((d) => d.kind === "videoinput");
    if (sel == null || cams.length === 0) {
        return { device: null, matchedBy: "none" };
    }

    // 1. El deviceId que ya funcionó antes: el camino rápido y exacto.
    if (sel.deviceid) {
        const hit = cams.find((d) => d.deviceId === sel.deviceid);
        if (hit) {
            return { device: hit, matchedBy: "deviceid" };
        }
    }

    // 2. La ruta PnP del host aparece a veces dentro del label en Linux; en
    //    Windows no, así que esto es oportunista y nunca obligatorio.
    if (sel.hardwareid) {
        const needle = norm(sel.hardwareid);
        const hit = cams.find((d) => needle !== "" && norm(d.label).includes(needle));
        if (hit) {
            return { device: hit, matchedBy: "hardwareid" };
        }
    }

    // 3. vid/pid: sobrevive al reenchufe, al cambio de puerto y al renombre.
    if (sel.vid && sel.pid) {
        const want = { vid: norm(sel.vid), pid: norm(sel.pid) };
        const hits = cams.filter((d) => {
            const got = parseVidPid(d.label);
            return got != null && got.vid === want.vid && got.pid === want.pid;
        });
        if (hits.length === 1) {
            return { device: hits[0], matchedBy: "vidpid" };
        }
        if (hits.length > 1) {
            // Dos capturadoras idénticas: sin más datos no se puede elegir.
            return { device: null, matchedBy: "ambiguous_name" };
        }
    }

    // 4. El nombre, y sólo si es inequívoco.
    if (sel.name) {
        const want = norm(sel.name);
        const hits = cams.filter((d) => norm(baseLabel(d.label)) === want || norm(d.label) === want);
        if (hits.length === 1) {
            return { device: hits[0], matchedBy: "name" };
        }
        if (hits.length > 1) {
            return { device: null, matchedBy: "ambiguous_name" };
        }
    }

    // Nada matcheó. No se elige "la primera cámara que haya".
    return { device: null, matchedBy: "none" };
}

// Sin permiso de cámara, Chromium devuelve los dispositivos con label vacío. Se
// distingue de "no hay cámaras" porque la respuesta al usuario es distinta:
// pedir permiso, no enchufar hardware.
export function labelsAreHidden(devices: EnumeratedDevice[]): boolean {
    const cams = (devices ?? []).filter((d) => d.kind === "videoinput");
    return cams.length > 0 && cams.every((d) => (d.label ?? "") === "");
}

// Restricciones de getUserMedia para una fuente ya resuelta. `exact` es
// deliberado: si el device desapareció entre la resolución y la apertura,
// preferimos un OverconstrainedError explícito antes que abrir otra cámara.
export function buildConstraints(deviceId: string, width?: number, height?: number): MediaStreamConstraints {
    return {
        audio: false,
        video: {
            deviceId: { exact: deviceId },
            width: { ideal: width && width > 0 ? width : 1920 },
            height: { ideal: height && height > 0 ? height : 1080 },
        },
    };
}

// Traducción de los errores de getUserMedia a la taxonomía compartida.
export function classifyMediaError(err: unknown): { code: string; detail: string } {
    const name = (err as { name?: string })?.name ?? "";
    const detail = (err as { message?: string })?.message ?? String(err ?? "");
    switch (name) {
        case "NotAllowedError":
        case "SecurityError":
            return { code: "PERMISSION_DENIED", detail };
        case "NotFoundError":
        case "OverconstrainedError":
            return { code: "DEVICE_REMOVED", detail };
        case "NotReadableError":
        case "AbortError":
            // Windows entrega NotReadableError cuando otro proceso ya tiene el
            // pin de la capturadora tomado.
            return { code: "DEVICE_BUSY", detail };
        case "TypeError":
            return { code: "UNSUPPORTED_FORMAT", detail };
        default:
            return { code: "STREAM_FAILED", detail };
    }
}
