// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    executionDetailLines,
    executionLine,
    executorText,
    isWorking,
    needsAttention,
    originText,
    tokensText,
    type MissionExecution,
} from "./execution";
import { computeTransitions, summarizeCounts, tooltipLine, type MissionSnapshot } from "./status-model";

function exec(state: MissionExecution["state"], extra: Partial<MissionExecution> = {}): MissionExecution {
    const working = ["RUNNING", "STARTING", "DISPATCHED", "WAITING"].includes(state);
    const attention = ["WAITING_APPROVAL", "BLOCKED"].includes(state);
    return { state, label: state.replace("_", " "), working, attention, summary_line: `${state} · rig3060 · 3m 12s`, ...extra };
}

function snap(id: string, status: string, execution?: MissionExecution): MissionSnapshot {
    return { mission_id: id, name: `m ${id}`, status, execution };
}

describe("vista de ejecución (m-55abf16276: 7,5 h «trabajando» sin arrancar)", () => {
    it("usa el estado del cerebro y cae al status si no hay vista", () => {
        expect(isWorking(snap("1", "running", exec("RUNNING")))).toBe(true);
        expect(isWorking(snap("2", "running", exec("BLOCKED")))).toBe(false);
        expect(isWorking(snap("3", "running"))).toBe(true);
        expect(needsAttention(snap("4", "blocked", exec("WAITING_APPROVAL")))).toBe(true);
        expect(needsAttention(snap("5", "blocked"))).toBe(true);
    });

    it("el tooltip dice el estado real, host, duración y fase", () => {
        const m = snap(
            "1",
            "running",
            exec("RUNNING", { phase_line: "paso 2 (implementer): revisar servicios del Media Center" })
        );
        expect(tooltipLine(m)).toBe(
            "m 1 — RUNNING · rig3060 · 3m 12s — paso 2 (implementer): revisar servicios del Media Center"
        );
        expect(tooltipLine(snap("2", "running"))).toBe("m 2 — trabajando");
    });

    it("una misión DISPATCHED/START FAILED no se cuenta como trabajando sin decirlo", () => {
        const counts = summarizeCounts([
            snap("1", "running", exec("RUNNING")),
            snap("2", "blocked", exec("START_FAILED", { attention: true })),
            snap("3", "failed", exec("START_FAILED", { attention: false })),
        ]);
        expect(counts).toEqual({ working: 1, attention: 1 });
    });

    it("START FAILED notifica con host/shell y sin tokens inventados", () => {
        const failed = snap(
            "1",
            "failed",
            exec("START_FAILED", {
                summary_line: "START FAILED · local-windows / PowerShell · 0s",
                detail: "claude-cli arma comandos posix y el target recibe PowerShell",
                activity_line: "No se consumieron tokens de modelo.",
            })
        );
        const out = computeTransitions(new Map([["1", "running"]]), [failed]);
        expect(out[0].title).toContain("No arrancó");
        expect(out[0].body).toContain("START FAILED · local-windows / PowerShell");
        expect(out[0].body).toContain("No se consumieron tokens");
    });

    it("líneas auxiliares: detalle, ejecutor, consumo y origen", () => {
        const e = exec("RUNNING", {
            phase_line: "paso 1",
            activity_line: "Última actividad: hace 8s (process_cpu)",
            executor: { agent: "claude-cli", model: "fable" },
            attempt: 2,
            tokens: { model_steps: 3, total_tokens: 42_000, cost_usd: 0.5 },
            origin: { client_environment: "local-windows", cwd: "C:/Users/ndf14", terminal_used_as: "context_only" },
        });
        expect(executionDetailLines({ status: "running", execution: e })).toEqual([
            "paso 1",
            "Última actividad: hace 8s (process_cpu)",
        ]);
        expect(executionLine({ status: "running", execution: e })).toContain("RUNNING");
        expect(executorText(e)).toBe("claude-cli/fable · intento 2");
        expect(tokensText(e.tokens)).toBe("3 pasos · 42k tokens · US$ 0.50");
        expect(tokensText({ model_steps: 0 })).toBe("sin consumo de modelo");
        expect(originText(e)).toBe("pedido desde local-windows (C:/Users/ndf14) · terminal usada como contexto");
    });
});
