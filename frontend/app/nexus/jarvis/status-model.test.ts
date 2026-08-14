// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { computeTransitions, missionLabel, summarizeCounts, type MissionSnapshot } from "./status-model";

function snap(id: string, status: string, extra: Partial<MissionSnapshot> = {}): MissionSnapshot {
    return { mission_id: id, name: `m ${id}`, status, ...extra };
}

describe("summarizeCounts", () => {
    it("counts working and attention states", () => {
        const counts = summarizeCounts([
            snap("1", "running"),
            snap("2", "recovering"),
            snap("3", "needs_input"),
            snap("4", "blocked"),
            snap("5", "completed"),
            snap("6", "stopped"),
        ]);
        expect(counts).toEqual({ working: 2, attention: 2 });
    });
});

describe("computeTransitions (§8: solo atención, jamás pasos)", () => {
    it("does not notify on the first poll", () => {
        expect(computeTransitions(new Map(), [snap("1", "completed")])).toEqual([]);
    });

    it("notifies completion with the result, not logs", () => {
        const prev = new Map([["1", "running"]]);
        const out = computeTransitions(prev, [
            snap("1", "completed", { result_summary: "Causa: dedupe roto. 47 tests OK." }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].title).toContain("✓");
        expect(out[0].body).toContain("47 tests OK");
    });

    it("notifies needs_input and blocked with the reason", () => {
        const prev = new Map([
            ["1", "running"],
            ["2", "running"],
        ]);
        const out = computeTransitions(prev, [
            snap("1", "needs_input", { needs_attention: "falta credencial" }),
            snap("2", "blocked", { needs_attention: "loop de evaluación" }),
        ]);
        expect(out).toHaveLength(2);
        expect(out[0].body).toBe("falta credencial");
    });

    it("stays silent for running-to-running and internal steps", () => {
        const prev = new Map([["1", "running"]]);
        expect(computeTransitions(prev, [snap("1", "running")])).toEqual([]);
        expect(computeTransitions(prev, [snap("1", "paused")])).toEqual([]);
        expect(computeTransitions(prev, [snap("1", "stopped")])).toEqual([]);
    });

    it("does not re-notify an unchanged terminal state", () => {
        const prev = new Map([["1", "completed"]]);
        expect(computeTransitions(prev, [snap("1", "completed")])).toEqual([]);
    });
});

describe("missionLabel", () => {
    it("prefers name, then objective, never the raw id when avoidable", () => {
        expect(missionLabel(snap("1", "running"))).toBe("m 1");
        expect(missionLabel({ mission_id: "m-x", status: "running", objective: "arreglar CV" })).toBe("arreglar CV");
        expect(missionLabel({ mission_id: "m-x", status: "running" })).toBe("m-x");
    });
});
