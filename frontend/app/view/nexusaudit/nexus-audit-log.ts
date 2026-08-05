// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Lectura del audit append-only que escribe el servidor MCP (nexus/mcp/policy.go).
// Cada línea es un objeto JSON; una línea corrupta no puede tumbar el panel, así
// que se conserva como registro inválido en vez de descartarse en silencio.

export type AuditDecision = "executed" | "confirmed" | "confirmation_required" | "blocked" | "error" | "unknown";

export type AuditRecord = {
    line: number;
    ts: string;
    tool: string;
    env: string;
    detail: string;
    decision: string;
    redacted?: number;
    malformed?: boolean;
    raw?: string;
};

export type AuditFilter = {
    text?: string;
    env?: string;
    decision?: string;
    onlySensitive?: boolean;
};

function classify(decision: string): AuditDecision {
    if (decision === "executed" || decision === "confirmed" || decision === "confirmation_required" || decision === "blocked") {
        return decision;
    }
    if (decision?.startsWith("error")) {
        return "error";
    }
    return "unknown";
}

export function parseAuditLog(text: string): AuditRecord[] {
    if (!text) {
        return [];
    }
    const out: AuditRecord[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") {
            continue;
        }
        try {
            const rec = JSON.parse(line);
            if (!rec || typeof rec !== "object") {
                throw new Error("no es un objeto");
            }
            out.push({
                line: i + 1,
                ts: typeof rec.ts === "string" ? rec.ts : "",
                tool: typeof rec.tool === "string" ? rec.tool : "",
                env: typeof rec.env === "string" ? rec.env : "",
                detail: typeof rec.detail === "string" ? rec.detail : "",
                decision: typeof rec.decision === "string" ? rec.decision : "",
                redacted: typeof rec.redacted === "number" ? rec.redacted : undefined,
            });
        } catch {
            out.push({ line: i + 1, ts: "", tool: "", env: "", detail: "", decision: "", malformed: true, raw: line });
        }
    }
    return out;
}

// Una acción es sensible si el motor pidió confirmación, si se confirmó una
// acción privilegiada, si fue bloqueada o si hubo que ocultar credenciales.
export function isSensitive(rec: AuditRecord): boolean {
    if (rec.malformed) {
        return true;
    }
    if (rec.redacted != null && rec.redacted > 0) {
        return true;
    }
    const kind = classify(rec.decision);
    return kind === "confirmation_required" || kind === "confirmed" || kind === "blocked" || kind === "error";
}

export function decisionKind(rec: AuditRecord): AuditDecision {
    return classify(rec.decision);
}

export function filterAuditRecords(records: AuditRecord[], filter: AuditFilter): AuditRecord[] {
    const text = filter.text?.trim().toLowerCase();
    return records.filter((rec) => {
        if (filter.onlySensitive && !isSensitive(rec)) {
            return false;
        }
        if (filter.env && filter.env !== rec.env) {
            return false;
        }
        if (filter.decision && filter.decision !== rec.decision) {
            return false;
        }
        if (text) {
            const haystack = `${rec.tool} ${rec.env} ${rec.detail} ${rec.decision} ${rec.raw ?? ""}`.toLowerCase();
            if (!haystack.includes(text)) {
                return false;
            }
        }
        return true;
    });
}

export function auditEnvironments(records: AuditRecord[]): string[] {
    return Array.from(new Set(records.map((rec) => rec.env).filter(Boolean))).sort();
}

export function auditDecisions(records: AuditRecord[]): string[] {
    return Array.from(new Set(records.map((rec) => rec.decision).filter(Boolean))).sort();
}

export type AuditSummary = {
    total: number;
    sensitive: number;
    redacted: number;
    awaitingConfirmation: number;
    errors: number;
};

export function summarizeAudit(records: AuditRecord[]): AuditSummary {
    const summary: AuditSummary = { total: records.length, sensitive: 0, redacted: 0, awaitingConfirmation: 0, errors: 0 };
    for (const rec of records) {
        if (isSensitive(rec)) summary.sensitive++;
        if (rec.redacted) summary.redacted += rec.redacted;
        const kind = decisionKind(rec);
        if (kind === "confirmation_required") summary.awaitingConfirmation++;
        if (kind === "error") summary.errors++;
    }
    return summary;
}
