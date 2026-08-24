// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    baseLabel,
    buildConstraints,
    classifyMediaError,
    labelsAreHidden,
    parseVidPid,
    resolveDevice,
    type EnumeratedDevice,
} from "./device-resolver";

// Lo que ve el renderer en el host real: la capturadora MS2109 y la webcam
// personal. Chromium anexa el par vid:pid al label.
const capture: EnumeratedDevice = {
    deviceId: "aaaa1111",
    label: "USB Video (534d:2109)",
    kind: "videoinput",
    groupId: "g1",
};
const webcam: EnumeratedDevice = {
    deviceId: "bbbb2222",
    label: "HD Pro Webcam C920 (046d:082d)",
    kind: "videoinput",
    groupId: "g2",
};
const micro: EnumeratedDevice = {
    deviceId: "cccc3333",
    label: "Digital Audio Interface (USB Digital Audio)",
    kind: "audioinput",
    groupId: "g1",
};
const devices = [capture, webcam, micro];

describe("parseo del label", () => {
    it("extrae vid/pid del sufijo que agrega Chromium", () => {
        expect(parseVidPid("USB Video (534d:2109)")).toEqual({ vid: "534d", pid: "2109" });
        expect(parseVidPid("USB Video")).toBeNull();
    });

    it("deja el nombre sin el sufijo de ids para comparar contra la config", () => {
        expect(baseLabel("USB Video (534d:2109)")).toBe("USB Video");
        expect(baseLabel("USB Video")).toBe("USB Video");
    });
});

describe("resolucion del dispositivo", () => {
    it("prefiere el deviceId ya conocido", () => {
        const match = resolveDevice({ deviceid: "aaaa1111", name: "otra cosa" }, devices);
        expect(match.matchedBy).toBe("deviceid");
        expect(match.device?.deviceId).toBe("aaaa1111");
    });

    it("cae en vid/pid cuando el deviceId ya no existe", () => {
        // Caso real: se borraron los datos del sitio o cambio el perfil.
        const match = resolveDevice({ deviceid: "viejo", vid: "534d", pid: "2109" }, devices);
        expect(match.matchedBy).toBe("vidpid");
        expect(match.device?.deviceId).toBe("aaaa1111");
    });

    it("resuelve por nombre solo si es inequivoco", () => {
        const match = resolveDevice({ name: "USB Video" }, devices);
        expect(match.matchedBy).toBe("name");
        expect(match.device?.deviceId).toBe("aaaa1111");
    });

    it("NUNCA cae en la webcam personal cuando la capturadora no esta", () => {
        // La capturadora esta desenchufada: queda una sola camara, la personal.
        const match = resolveDevice({ name: "USB Video", vid: "534d", pid: "2109" }, [webcam, micro]);
        expect(match.device).toBeNull();
        expect(match.matchedBy).toBe("none");
    });

    it("se niega a elegir entre dos dispositivos con el mismo nombre", () => {
        const gemela: EnumeratedDevice = { deviceId: "dddd4444", label: "USB Video (1de1:f105)", kind: "videoinput" };
        const match = resolveDevice({ name: "USB Video" }, [capture, gemela]);
        expect(match.device).toBeNull();
        expect(match.matchedBy).toBe("ambiguous_name");
    });

    it("ignora los dispositivos que no son de video", () => {
        const match = resolveDevice({ name: "Digital Audio Interface (USB Digital Audio)" }, devices);
        expect(match.device).toBeNull();
    });

    it("no resuelve nada sin selector ni sin camaras", () => {
        expect(resolveDevice(undefined, devices).device).toBeNull();
        expect(resolveDevice({ name: "USB Video" }, []).device).toBeNull();
    });
});

describe("permiso de camara", () => {
    it("distingue labels ocultos de ausencia de camaras", () => {
        // Sin permiso, Chromium devuelve los dispositivos con label vacio: hay
        // hardware, falta autorizacion.
        expect(labelsAreHidden([{ deviceId: "x", label: "", kind: "videoinput" }])).toBe(true);
        expect(labelsAreHidden(devices)).toBe(false);
        expect(labelsAreHidden([micro])).toBe(false);
    });
});

describe("constraints", () => {
    it("pide el device exacto para no abrir otra camara", () => {
        const c = buildConstraints("aaaa1111", 1920, 1080) as { video: MediaTrackConstraints };
        expect((c.video.deviceId as ConstrainDOMStringParameters).exact).toBe("aaaa1111");
        expect(c.video.width).toEqual({ ideal: 1920 });
    });

    it("sin resolucion configurada pide 1080p", () => {
        const c = buildConstraints("aaaa1111") as { video: MediaTrackConstraints };
        expect(c.video.height).toEqual({ ideal: 1080 });
    });

    it("nunca pide audio: este slice es video", () => {
        expect(buildConstraints("aaaa1111").audio).toBe(false);
    });
});

describe("clasificacion de errores de getUserMedia", () => {
    it("mapea cada fallo del navegador a la taxonomia compartida", () => {
        const cases: [string, string][] = [
            ["NotAllowedError", "PERMISSION_DENIED"],
            ["NotFoundError", "DEVICE_REMOVED"],
            ["OverconstrainedError", "DEVICE_REMOVED"],
            ["NotReadableError", "DEVICE_BUSY"],
            ["TypeError", "UNSUPPORTED_FORMAT"],
            ["AlgoRaro", "STREAM_FAILED"],
        ];
        for (const [name, code] of cases) {
            const err = new Error("detalle");
            err.name = name;
            expect(classifyMediaError(err).code, name).toBe(code);
        }
    });
});
