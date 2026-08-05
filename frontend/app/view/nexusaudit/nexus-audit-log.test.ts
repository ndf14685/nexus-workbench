// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    auditDecisions,
    auditEnvironments,
    decisionKind,
    filterAuditRecords,
    isSensitive,
    parseAuditLog,
    summarizeAudit,
} from "./nexus-audit-log";

const log = [
    `{"ts":"2026-08-05T10:00:00Z","tool":"run_command","env":"lab","detail":"kubectl get pods","decision":"executed"}`,
    `{"ts":"2026-08-05T10:01:00Z","tool":"run_command","env":"prod-k8s","detail":"kubectl delete ns staging","decision":"confirmation_required"}`,
    `{"ts":"2026-08-05T10:01:30Z","tool":"run_command","env":"prod-k8s","detail":"kubectl delete ns staging","decision":"confirmed"}`,
    `{"ts":"2026-08-05T10:02:00Z","tool":"run_command","env":"lab","detail":"export TOKEN=«REDACTADO»","decision":"executed","redacted":1}`,
    `{"ts":"2026-08-05T10:03:00Z","tool":"open_file","env":"lab","detail":"/etc/hosts","decision":"error: no such file"}`,
].join("\n");

describe("audit log", () => {
    it("parses every record with its line number", () => {
        const records = parseAuditLog(log);
        expect(records).toHaveLength(5);
        expect(records[0]).toMatchObject({ line: 1, tool: "run_command", env: "lab", decision: "executed" });
        expect(records[3].redacted).toBe(1);
    });

    it("keeps a corrupted line instead of dropping it silently", () => {
        const records = parseAuditLog(`{"ts":"x","tool":"run_command"}\n{roto\n`);
        expect(records).toHaveLength(2);
        expect(records[1].malformed).toBe(true);
        expect(records[1].raw).toBe("{roto");
        // una línea corrupta en un audit append-only es en sí misma una señal
        expect(isSensitive(records[1])).toBe(true);
    });

    it("ignores blank lines", () => {
        expect(parseAuditLog("\n\n")).toEqual([]);
        expect(parseAuditLog("")).toEqual([]);
    });

    it("classifies decisions, treating any error prefix as error", () => {
        const records = parseAuditLog(log);
        expect(decisionKind(records[0])).toBe("executed");
        expect(decisionKind(records[1])).toBe("confirmation_required");
        expect(decisionKind(records[4])).toBe("error");
    });

    it("marks privileged and redacted actions as sensitive", () => {
        const records = parseAuditLog(log);
        expect(isSensitive(records[0])).toBe(false);
        expect(isSensitive(records[1])).toBe(true);
        expect(isSensitive(records[2])).toBe(true);
        expect(isSensitive(records[3])).toBe(true);
        expect(isSensitive(records[4])).toBe(true);
    });

    it("filters by environment, decision, free text and sensitivity", () => {
        const records = parseAuditLog(log);
        expect(filterAuditRecords(records, { env: "prod-k8s" })).toHaveLength(2);
        expect(filterAuditRecords(records, { decision: "executed" })).toHaveLength(2);
        expect(filterAuditRecords(records, { text: "DELETE NS" })).toHaveLength(2);
        expect(filterAuditRecords(records, { onlySensitive: true })).toHaveLength(4);
        expect(filterAuditRecords(records, { onlySensitive: true, env: "lab" })).toHaveLength(2);
    });

    it("lists the environments and decisions present", () => {
        const records = parseAuditLog(log);
        expect(auditEnvironments(records)).toEqual(["lab", "prod-k8s"]);
        expect(auditDecisions(records)).toContain("confirmation_required");
    });

    it("summarizes what needs attention", () => {
        expect(summarizeAudit(parseAuditLog(log))).toEqual({
            total: 5,
            sensitive: 4,
            redacted: 1,
            awaitingConfirmation: 1,
            errors: 1,
        });
    });
});
