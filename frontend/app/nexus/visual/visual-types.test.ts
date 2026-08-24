// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { describeVisualError, findSource, normalizeAIVision, sourceLabel } from "./visual-types";
import { findVisualBlock } from "./open-visual-block";

describe("modo de observacion por IA", () => {
    it("el default es on_demand y nunca continuous", () => {
        expect(normalizeAIVision(undefined)).toBe("on_demand");
        expect(normalizeAIVision("")).toBe("on_demand");
        // `continuous` no se acepta desde configuracion: habilitarlo tiene que
        // ser una decision deliberada, no un typo heredado.
        expect(normalizeAIVision("continuous")).toBe("on_demand");
        expect(normalizeAIVision("cualquiera")).toBe("on_demand");
    });

    it("respeta off y changes", () => {
        expect(normalizeAIVision("off")).toBe("off");
        expect(normalizeAIVision("OFF")).toBe("off");
        expect(normalizeAIVision("changes")).toBe("changes");
    });
});

describe("etiqueta de la fuente", () => {
    it("cae en el id cuando no hay label", () => {
        expect(sourceLabel({ id: "hdmi-primary", label: "Banco" })).toBe("Banco");
        expect(sourceLabel({ id: "hdmi-primary" })).toBe("hdmi-primary");
        expect(sourceLabel({ id: "hdmi-primary", label: "   " })).toBe("hdmi-primary");
    });

    it("nada en el modelo sabe que es un banco: es solo texto", () => {
        // La etiqueta es configuracion pura; cambiarla no cambia ningun camino.
        expect(sourceLabel({ id: "x", label: "Laboratorio" })).toBe("Laboratorio");
    });
});

describe("busqueda de fuente", () => {
    const sources = [
        { id: "hdmi-primary", label: "Banco" },
        { id: "hdmi-lab", label: "Lab" },
    ];
    it("resuelve por id exacto", () => {
        expect(findSource(sources, "hdmi-lab")?.label).toBe("Lab");
        expect(findSource(sources, "no-existe")).toBeNull();
    });
});

describe("mensajes de error", () => {
    it("cada codigo dice que hacer, no solo que fallo", () => {
        expect(describeVisualError("PERMISSION_DENIED")).toContain("Privacidad y permisos");
        expect(describeVisualError("DEVICE_BUSY")).toContain("usando la capturadora");
        expect(describeVisualError("DEVICE_REMOVED")).toContain("desconect");
        // Un fallo desconocido muestra el detalle real en vez de un texto vacio.
        expect(describeVisualError("STREAM_FAILED", "algo raro")).toBe("algo raro");
    });
});

describe("deduplicacion del boton HMI", () => {
    const blocks = [
        { blockId: "b1", view: "term" },
        { blockId: "b2", view: "visual", sourceId: "hdmi-primary" },
    ];

    it("encuentra el bloque que ya muestra esa fuente", () => {
        expect(findVisualBlock(blocks, "hdmi-primary")).toBe("b2");
    });

    it("no considera duplicado un bloque de otra fuente", () => {
        // Dos capturadoras distintas son dos bloques legitimos.
        expect(findVisualBlock(blocks, "hdmi-lab")).toBeNull();
    });

    it("un bloque sin fuente fijada adopta la pedida", () => {
        const sinFuente = [{ blockId: "b3", view: "visual" }];
        expect(findVisualBlock(sinFuente, "hdmi-primary")).toBe("b3");
    });

    it("sin fuente pedida enfoca el primer bloque visual", () => {
        expect(findVisualBlock(blocks)).toBe("b2");
    });

    it("sin bloques visuales devuelve null para que se cree uno", () => {
        expect(findVisualBlock([{ blockId: "b1", view: "term" }], "hdmi-primary")).toBeNull();
        expect(findVisualBlock([])).toBeNull();
    });
});
