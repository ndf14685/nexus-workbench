// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { waveEventSubscribeSingle } from "@/app/store/wps";
import clsx from "clsx";
import * as React from "react";

export type TerminalMetricsMode = "off" | "compact" | "full";

export type TerminalMetricSnapshot = {
    ts: number;
    cpuPercent: number;
    memoryUsedGb: number;
    memoryTotalGb: number;
    memoryPercent: number;
    diskUsedPercent?: number;
};

const MetricFreshnessMs = 5_000;

function clampPercent(value: unknown): number {
    return Math.min(100, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
}

export function normalizeTerminalMetricsMode(value: unknown): TerminalMetricsMode {
    return value === "compact" || value === "full" ? value : "off";
}

export function terminalMetricSnapshotFromEvent(
    event: Extract<WaveEvent, { event: "sysinfo" }>
): TerminalMetricSnapshot | null {
    const data = event?.data;
    if (!data || !Number.isFinite(data.ts) || !data.values) return null;
    const memoryUsedGb = Math.max(0, Number(data.values["mem:used"]) || 0);
    const memoryTotalGb = Math.max(0, Number(data.values["mem:total"]) || 0);
    const diskRaw = data.values["disk:usedpct"];
    return {
        ts: data.ts,
        cpuPercent: clampPercent(data.values.cpu),
        memoryUsedGb,
        memoryTotalGb,
        memoryPercent: memoryTotalGb > 0 ? clampPercent((memoryUsedGb / memoryTotalGb) * 100) : 0,
        ...(Number.isFinite(diskRaw) ? { diskUsedPercent: clampPercent(diskRaw) } : {}),
    };
}

export function isTerminalMetricSnapshotFresh(
    snapshot: Pick<TerminalMetricSnapshot, "ts"> | null,
    now = Date.now()
): boolean {
    return snapshot != null && now - snapshot.ts <= MetricFreshnessMs;
}

function Metric({ label, value, detail }: { label: string; value: number; detail?: string }) {
    const rounded = Math.round(value);
    return (
        <span className="term-metric" title={`${label}: ${detail ?? `${rounded}%`}`}>
            <span className="term-metric-label">{label}</span>
            <span className="term-metric-value">{rounded}%</span>
            <span className="term-metric-track" aria-hidden="true">
                <span className="term-metric-fill" style={{ width: `${rounded}%` }} />
            </span>
        </span>
    );
}

export function TerminalMetrics({ mode, connection }: { mode: TerminalMetricsMode; connection?: string }) {
    const [snapshot, setSnapshot] = React.useState<TerminalMetricSnapshot | null>(null);
    const [now, setNow] = React.useState(Date.now());
    const scope = connection || "local";

    React.useEffect(() => {
        if (mode === "off") {
            setSnapshot(null);
            return;
        }
        const unsubscribe = waveEventSubscribeSingle({
            eventType: "sysinfo",
            scope,
            handler: (event) => {
                const next = terminalMetricSnapshotFromEvent(event);
                if (next) {
                    setSnapshot(next);
                    setNow(Date.now());
                }
            },
        });
        const freshnessTimer = window.setInterval(() => setNow(Date.now()), 2_000);
        return () => {
            window.clearInterval(freshnessTimer);
            unsubscribe();
        };
    }, [mode, scope]);

    if (mode === "off") return null;
    const fresh = isTerminalMetricSnapshotFresh(snapshot, now);
    return (
        <div
            className={clsx("term-metrics", `term-metrics-${mode}`, { "term-metrics-stale": !fresh })}
            role="status"
            aria-live="off"
            aria-label={fresh ? `System metrics for ${scope}` : `Waiting for system metrics from ${scope}`}
        >
            <span className="term-metrics-host" title={scope}>
                {scope}
            </span>
            {fresh ? (
                <>
                    <Metric label="CPU" value={snapshot.cpuPercent} />
                    <Metric
                        label="RAM"
                        value={snapshot.memoryPercent}
                        detail={`${snapshot.memoryUsedGb.toFixed(1)} / ${snapshot.memoryTotalGb.toFixed(1)} GB`}
                    />
                    {mode === "full" && snapshot.diskUsedPercent != null && (
                        <Metric label="DISK" value={snapshot.diskUsedPercent} />
                    )}
                </>
            ) : (
                <span className="term-metrics-waiting">Esperando métricas…</span>
            )}
        </div>
    );
}
