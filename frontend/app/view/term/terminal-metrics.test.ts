import { describe, expect, it } from "vitest";
import {
    isTerminalMetricSnapshotFresh,
    normalizeTerminalMetricsMode,
    terminalMetricSnapshotFromEvent,
} from "./terminal-metrics";

describe("terminalMetricSnapshotFromEvent", () => {
    it("normalizes CPU, memory and disk values from sysinfo", () => {
        const snapshot = terminalMetricSnapshotFromEvent({
            event: "sysinfo",
            scopes: ["local"],
            data: {
                ts: 1_000,
                values: {
                    cpu: 42.4,
                    "mem:used": 7.5,
                    "mem:total": 16,
                    "disk:usedpct": 61.2,
                },
            },
        } as Extract<WaveEvent, { event: "sysinfo" }>);

        expect(snapshot).toEqual({
            ts: 1_000,
            cpuPercent: 42.4,
            memoryUsedGb: 7.5,
            memoryTotalGb: 16,
            memoryPercent: 46.875,
            diskUsedPercent: 61.2,
        });
    });

    it("clamps percentages and rejects unusable events", () => {
        expect(
            terminalMetricSnapshotFromEvent({
                event: "sysinfo",
                data: { ts: 1, values: { cpu: 140, "mem:used": -1, "mem:total": 0 } },
            } as Extract<WaveEvent, { event: "sysinfo" }>)
        ).toMatchObject({ cpuPercent: 100, memoryPercent: 0 });
        expect(
            terminalMetricSnapshotFromEvent({ event: "sysinfo" } as Extract<WaveEvent, { event: "sysinfo" }>)
        ).toBeNull();
    });
});

describe("terminal metrics preferences", () => {
    it("keeps telemetry opt-in and accepts supported per-terminal modes", () => {
        expect(normalizeTerminalMetricsMode(undefined)).toBe("off");
        expect(normalizeTerminalMetricsMode("compact")).toBe("compact");
        expect(normalizeTerminalMetricsMode("full")).toBe("full");
        expect(normalizeTerminalMetricsMode("unexpected")).toBe("off");
    });

    it("marks old data stale", () => {
        const snapshot = { ts: 1_000 } as ReturnType<typeof terminalMetricSnapshotFromEvent>;
        expect(isTerminalMetricSnapshotFresh(snapshot, 5_999)).toBe(true);
        expect(isTerminalMetricSnapshotFresh(snapshot, 6_001)).toBe(false);
        expect(isTerminalMetricSnapshotFresh(null, 1_000)).toBe(false);
    });
});
