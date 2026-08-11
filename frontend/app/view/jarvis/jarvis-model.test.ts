// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    dodProgress,
    lastDecisionText,
    mergeMissionUpdate,
    summarizeMissions,
    type MissionSnapshot,
} from "./jarvis-model";

function mission(overrides: Partial<MissionSnapshot>): MissionSnapshot {
    return {
        mission_id: "m-1",
        objective: "obj",
        status: "running",
        strategy: "",
        priority: "normal",
        execution_target: "rig3060",
        repo: "",
        definition_of_done: [],
        workers: [],
        last_decision: null,
        needs_attention: null,
        updated_at: 1,
        ...overrides,
    };
}

describe("mergeMissionUpdate", () => {
    it("reemplaza por mission_id y ordena por updated_at desc", () => {
        const list = [mission({ mission_id: "m-1", updated_at: 1 }), mission({ mission_id: "m-2", updated_at: 5 })];
        const merged = mergeMissionUpdate(list, mission({ mission_id: "m-1", updated_at: 10, status: "completed" }));
        expect(merged).toHaveLength(2);
        expect(merged[0].mission_id).toBe("m-1");
        expect(merged[0].status).toBe("completed");
    });
});

describe("summarizeMissions", () => {
    it("cuenta running/recovering y needs_attention", () => {
        const list = [
            mission({ mission_id: "m-1", status: "running" }),
            mission({ mission_id: "m-2", status: "recovering" }),
            mission({ mission_id: "m-3", status: "blocked", needs_attention: "error repetido" }),
        ];
        expect(summarizeMissions(list)).toEqual({ running: 2, needsAttention: 1 });
    });
});

describe("lastDecisionText", () => {
    it("muestra verdict con razón", () => {
        const m = mission({ last_decision: { action: "verdict", verdict: "next", reason: "faltan tests" } });
        expect(lastDecisionText(m)).toBe("next: faltan tests");
    });
    it("tolera misiones sin decisiones", () => {
        expect(lastDecisionText(mission({}))).toBe("—");
    });
});

describe("dodProgress", () => {
    it("resume criterios satisfechos", () => {
        const m = mission({
            definition_of_done: [
                { text: "a", satisfied: true },
                { text: "b", satisfied: false },
            ],
        });
        expect(dodProgress(m)).toBe("1/2");
        expect(dodProgress(mission({}))).toBe("sin DoD");
    });
});
