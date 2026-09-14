// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// «¿Jarvis realmente está trabajando?» — la vista de ejecución que jarvisd
// deriva por misión (app/missions/lifecycle.py) y manda en el snapshot como
// `execution`. Lógica pura: el cerebro decide el estado y arma las líneas;
// acá sólo se eligen y se muestran, con fallback al `status` de siempre para
// cerebros que todavía no mandan la vista.
//
// Motivo (m-55abf16276, 2026-09-13): una misión figuró «trabajando» 7,5 h con
// un worker que nunca arrancó. `status: running` era todo lo que se veía.

export type ExecutionState =
    | "CREATED"
    | "DISPATCHED"
    | "STARTING"
    | "RUNNING"
    | "WAITING"
    | "WAITING_APPROVAL"
    | "BLOCKED"
    | "START_FAILED"
    | "FAILED"
    | "COMPLETED"
    | "STOPPED"
    | "PAUSED"
    | "RECOVERING";

export interface MissionExecutionTokens {
    steps_measured?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
    model_steps?: number;
}

export interface MissionExecution {
    state: ExecutionState;
    label: string;
    attention: boolean;
    working: boolean;
    waiting_on?: string | null;
    execution_host?: string | null;
    shell?: string | null;
    routing_reason?: string | null;
    origin?: { source?: string; client_environment?: string; cwd?: string; terminal_used_as?: string } | null;
    executor?: { agent?: string; model?: string | null; role?: string } | null;
    attempt?: number | null;
    previous_attempt_cause?: string | null;
    last_activity_at?: number | null;
    last_activity_source?: string | null;
    elapsed_s?: number | null;
    phase?: string | null;
    detail?: string | null;
    tokens?: MissionExecutionTokens | null;
    summary_line: string;
    phase_line?: string;
    activity_line?: string;
}

interface WithExecution {
    status: string;
    execution?: MissionExecution | null;
}

export const ExecutionStateColors: Record<string, string> = {
    RUNNING: "#3fb950",
    STARTING: "#7ee0e6",
    DISPATCHED: "#7ee0e6",
    WAITING: "#8b949e",
    WAITING_APPROVAL: "#d29922",
    BLOCKED: "#f85149",
    START_FAILED: "#f85149",
    FAILED: "#f85149",
    RECOVERING: "#d29922",
    COMPLETED: "#58a6ff",
    STOPPED: "#8b949e",
    PAUSED: "#8b949e",
    CREATED: "#8b949e",
};

const LegacyWorking = ["running", "recovering"];
const LegacyAttention = ["needs_input", "blocked"];

// ¿Hay un worker de verdad en marcha? Con vista, lo dice el cerebro
// (DISPATCHED/STARTING/RUNNING/WAITING); sin vista, el status de siempre.
export function isWorking(m: WithExecution): boolean {
    if (m.execution) {
        return !!m.execution.working;
    }
    return LegacyWorking.includes(m.status);
}

// ¿Le toca al dueño? START FAILED cuenta aunque la misión esté `failed`.
export function needsAttention(m: WithExecution): boolean {
    if (m.execution) {
        return !!m.execution.attention;
    }
    return LegacyAttention.includes(m.status);
}

// La línea de estado para tooltips y notificaciones: «RUNNING · rig3060 · 3m 12s».
export function executionLine(m: WithExecution): string {
    return m.execution?.summary_line ?? "";
}

// Las líneas que responden «qué está haciendo y desde cuándo», sin vacíos.
export function executionDetailLines(m: WithExecution): string[] {
    const e = m.execution;
    if (!e) {
        return [];
    }
    return [e.phase_line, e.activity_line].filter((line): line is string => !!line);
}

export function tokensText(tokens: MissionExecutionTokens | null | undefined): string {
    if (!tokens) {
        return "";
    }
    if (!tokens.model_steps) {
        return "sin consumo de modelo";
    }
    const parts = [`${tokens.model_steps} paso${tokens.model_steps == 1 ? "" : "s"}`];
    const total = tokens.total_tokens || (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0);
    if (total) {
        parts.push(`${Math.round(total / 1000)}k tokens`);
    }
    if (tokens.cost_usd) {
        parts.push(`US$ ${tokens.cost_usd.toFixed(2)}`);
    }
    return parts.join(" · ");
}

export function executorText(e: MissionExecution | null | undefined): string {
    if (!e?.executor?.agent) {
        return "";
    }
    const model = e.executor.model ? `/${e.executor.model}` : "";
    const attempt = e.attempt && e.attempt > 1 ? ` · intento ${e.attempt}` : "";
    return `${e.executor.agent}${model}${attempt}`;
}

export function originText(e: MissionExecution | null | undefined): string {
    const o = e?.origin;
    if (!o || !o.client_environment) {
        return "";
    }
    const how = o.terminal_used_as == "context_only" ? "contexto" : o.terminal_used_as == "repo" ? "repo" : "";
    return `pedido desde ${o.client_environment}${o.cwd ? ` (${o.cwd})` : ""}${how ? ` · terminal usada como ${how}` : ""}`;
}
