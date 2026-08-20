// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { TodayView } from "@/app/nexus/jarvis/brain-client";
import {
    EmptyToday,
    actionText,
    batchLine,
    calmLines,
    counters,
    decisionSummary,
    dueLabel,
    hiddenNeedsYouCount,
    isCalmMode,
    showDecisionSection,
    visibleNeedsYou,
} from "./operator-model";

function view(partial: Partial<TodayView>): TodayView {
    return { ...EmptyToday, ...partial };
}

describe("cockpit de atención", () => {
    it("colapsa a modo calmo solo en RECOVERY y sin nada urgente", () => {
        expect(isCalmMode(view({ operator_state: "RECOVERY", quiet: true }))).toBe(true);
        expect(isCalmMode(view({ operator_state: "RECOVERY", quiet: false }))).toBe(false);
        expect(isCalmMode(view({ operator_state: "NORMAL", quiet: true }))).toBe(false);
    });

    it("la tarjeta mínima muestra trabajo sacado, no trabajo pendiente", () => {
        const lines = calmLines(
            view({
                operator_state: "RECOVERY",
                quiet: true,
                message: "No hay nada urgente.",
                done_for_you: 7,
                running: 3,
                watching: 12,
            })
        );
        expect(lines).toEqual([
            "No hay nada urgente.",
            "7 tareas resueltas automáticamente.",
            "3 procesos siguen en ejecución.",
        ]);
        expect(lines.join(" ")).not.toContain("12");
    });

    it("la tarjeta mínima omite los ceros en vez de mostrarlos", () => {
        expect(calmLines(view({ message: "No hay nada urgente." }))).toEqual(["No hay nada urgente."]);
    });

    it("singulariza para no sonar a reporte", () => {
        const lines = calmLines(view({ done_for_you: 1, running: 1 }));
        expect(lines).toContain("1 tarea resuelta automáticamente.");
        expect(lines).toContain("1 proceso sigue en ejecución.");
    });

    it("el contador principal dice NEEDS YOU NOW, no NEEDS YOU", () => {
        const labels = counters(view({})).map((c) => c.label);
        expect(labels[0]).toBe("NEEDS YOU NOW");
    });

    it("las decisiones para despues nunca son un contador del cockpit", () => {
        const v = view({
            needs_you_total: 0,
            decisions_later: 2,
            decision_batches: [
                { batch: "portfolio-review", title: "Portfolio review", count: 1, cases: 16, urgent: 0, oldest_days: 3 },
                { batch: "evidence-review", title: "Professional evidence review", count: 1, cases: 5, urgent: 0, oldest_days: 1 },
            ],
        });
        expect(counters(v).map((c) => c.key)).not.toContain("decisions");
        expect(decisionSummary(v)).toBe("2 decisiones para después · 21 casos");
        expect(batchLine(v.decision_batches[0])).toBe("Portfolio review · 16 casos · 0 urgentes");
    });

    it("sin decisiones diferidas la seccion no existe", () => {
        const v = view({ decisions_later: 0 });
        expect(decisionSummary(v)).toBe("");
        expect(showDecisionSection(v, true)).toBe(false);
    });

    it("en RECOVERY la seccion de decisiones solo aparece si se abren detalles", () => {
        const v = view({ operator_state: "RECOVERY", decisions_later: 3 });
        expect(showDecisionSection(v, false)).toBe(false);
        expect(showDecisionSection(v, true)).toBe(true);
        const normal = view({ operator_state: "NORMAL", decisions_later: 3 });
        expect(showDecisionSection(normal, false)).toBe(true);
    });

    it("muestra cuatro contadores en NORMAL y esconde WATCHING en RECOVERY", () => {
        expect(counters(view({ operator_state: "NORMAL" })).map((c) => c.key)).toEqual([
            "needs",
            "running",
            "done",
            "watching",
        ]);
        expect(counters(view({ operator_state: "RECOVERY" })).map((c) => c.key)).toEqual([
            "needs",
            "running",
            "done",
        ]);
    });

    it("respeta el recorte del cerebro y nunca trae de más", () => {
        const entry = {
            work_item_id: "wi-1",
            title: "decidir algo",
            next_action: "Elegir una opción",
            reason: "alta importancia",
            domain: "projects",
            project: "",
            due_at: null,
            approval_required: false,
            can_delegate: false,
            score: 1,
        };
        const v = view({ needs_you: [entry], needs_you_total: 9 });
        expect(visibleNeedsYou(v)).toHaveLength(1);
        expect(hiddenNeedsYouCount(v)).toBe(8);
        expect(actionText(entry)).toBe("Elegir una opción");
    });

    it("cae al título cuando no hay acción concreta", () => {
        expect(
            actionText({
                work_item_id: "wi-2",
                title: "revisar el PR",
                next_action: "",
                reason: "",
                domain: "projects",
                project: "",
                due_at: null,
                approval_required: false,
                can_delegate: false,
                score: 0,
            })
        ).toBe("revisar el PR");
    });

    it("traduce deadlines a lenguaje humano", () => {
        const nowMs = 1_000_000_000_000;
        const nowS = nowMs / 1000;
        expect(dueLabel(null, nowMs)).toBe("");
        expect(dueLabel(nowS - 10, nowMs)).toBe("vencido");
        expect(dueLabel(nowS + 1800, nowMs)).toBe("vence en 30 min");
        expect(dueLabel(nowS + 6 * 3600, nowMs)).toBe("vence en 6 h");
        expect(dueLabel(nowS + 5 * 86400, nowMs)).toBe("vence en 5 d");
    });
});
