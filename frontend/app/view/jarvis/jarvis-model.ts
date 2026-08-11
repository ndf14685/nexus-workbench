// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Lógica pura del panel Jarvis Mission Supervisor (testeable sin React).
// El panel es una VISTA del cerebro (:8770): acá no hay decisiones ni estado
// propio — ADR "un cerebro, N shells" / adr-mission-supervisor.

export type MissionWorker = {
    id: string;
    agent: string;
    role: string;
    status: string;
    execution_host: string;
    connection: string;
    transport: string;
    block_id: string;
    cwd: string;
};

export type MissionSnapshot = {
    mission_id: string;
    objective: string;
    status: string;
    strategy: string;
    priority: string;
    execution_target: string;
    repo: string;
    definition_of_done: { text: string; satisfied: boolean; evidence?: string }[];
    workers: MissionWorker[];
    last_decision: Record<string, any> | null;
    needs_attention: string | null;
    updated_at: number;
};

export const MissionStatusColors: Record<string, string> = {
    running: "#3fb950",
    recovering: "#d29922",
    paused: "#8b949e",
    blocked: "#f85149",
    needs_input: "#f85149",
    completed: "#58a6ff",
    failed: "#f85149",
    stopped: "#8b949e",
    draft: "#8b949e",
};

export const WorkerStatusLabels: Record<string, string> = {
    working: "WORKING",
    idle: "IDLE",
    awaiting_review: "AWAITING REVIEW",
    manual_hold: "MANUAL",
    stalled: "STALLED",
    lost: "LOST",
    closed: "CLOSED",
    spawning: "SPAWNING",
};

// mergeMissionUpdate: aplica un snapshot (de GET /missions o del evento SSE
// mission.update) sobre la lista, sin duplicar y más reciente primero.
export function mergeMissionUpdate(
    missions: MissionSnapshot[],
    snapshot: MissionSnapshot
): MissionSnapshot[] {
    const rest = missions.filter((m) => m.mission_id !== snapshot.mission_id);
    return [...rest, snapshot].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

export function summarizeMissions(missions: MissionSnapshot[]): {
    running: number;
    needsAttention: number;
} {
    return {
        running: missions.filter((m) => m.status === "running" || m.status === "recovering").length,
        needsAttention: missions.filter((m) => m.needs_attention != null).length,
    };
}

export function lastDecisionText(mission: MissionSnapshot): string {
    const decision = mission.last_decision;
    if (decision == null) {
        return "—";
    }
    const action = decision.action ?? "";
    const reason = decision.reason ?? "";
    if (action === "verdict") {
        return `${decision.verdict ?? "?"}: ${reason}`;
    }
    return reason ? `${action}: ${reason}` : String(action || "—");
}

export function dodProgress(mission: MissionSnapshot): string {
    const total = mission.definition_of_done?.length ?? 0;
    if (total === 0) {
        return "sin DoD";
    }
    const done = mission.definition_of_done.filter((c) => c.satisfied).length;
    return `${done}/${total}`;
}
