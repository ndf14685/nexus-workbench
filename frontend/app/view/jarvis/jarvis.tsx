// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Panel Jarvis Mission Supervisor: vista minimalista del cerebro jarvisd.
// Config por meta del bloque: `jarvis:brainurl` (default http://127.0.0.1:8770)
// y `jarvis:braintoken` (bearer). Polling acotado (EventSource no permite
// Authorization; el push SSE queda para el jarvisagent headless).

import { globalStore } from "@/app/store/jotaiStore";
import { WOS } from "@/store/global";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import * as React from "react";
import {
    dodProgress,
    lastDecisionText,
    mergeMissionUpdate,
    MissionStatusColors,
    summarizeMissions,
    WorkerStatusLabels,
    type MissionSnapshot,
} from "./jarvis-model";

const RefreshMs = 3000;
const DefaultBrainUrl = "http://127.0.0.1:8770";

export class JarvisViewModel implements ViewModel {
    viewType: string;
    blockId: string;

    viewIcon = jotai.atom<string>("robot");
    viewName = jotai.atom<string>("Jarvis");
    noPadding = jotai.atom<boolean>(true);

    missionsAtom: jotai.PrimitiveAtom<MissionSnapshot[]>;
    errorAtom: jotai.PrimitiveAtom<string>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;

    disposed = false;
    timer: ReturnType<typeof setInterval> | null = null;

    constructor({ blockId }: ViewModelInitType) {
        this.viewType = "jarvis";
        this.blockId = blockId;
        this.missionsAtom = jotai.atom<MissionSnapshot[]>([]) as jotai.PrimitiveAtom<MissionSnapshot[]>;
        this.errorAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
        this.loadingAtom = jotai.atom<boolean>(true);
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), RefreshMs);
    }

    brainConfig(): { url: string; token: string } {
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", this.blockId)));
        const meta = block?.meta ?? {};
        return {
            url: String(meta["jarvis:brainurl"] ?? DefaultBrainUrl).replace(/\/$/, ""),
            token: String(meta["jarvis:braintoken"] ?? ""),
        };
    }

    async refresh() {
        if (this.disposed) {
            return;
        }
        const { url, token } = this.brainConfig();
        try {
            const headers: Record<string, string> = {};
            if (token) {
                headers["Authorization"] = `Bearer ${token}`;
            }
            const resp = await fetch(`${url}/missions`, { headers });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const body = await resp.json();
            let missions: MissionSnapshot[] = [];
            for (const snapshot of body?.missions ?? []) {
                missions = mergeMissionUpdate(missions, snapshot);
            }
            globalStore.set(this.missionsAtom, missions);
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            globalStore.set(this.errorAtom, `Cerebro no conectado (${url}): ${e}`);
        } finally {
            globalStore.set(this.loadingAtom, false);
        }
    }

    dispose() {
        this.disposed = true;
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    get viewComponent(): ViewComponent {
        return JarvisView;
    }
}

const statusChip = (status: string): React.CSSProperties => ({
    display: "inline-block",
    padding: "1px 8px",
    borderRadius: 8,
    fontSize: 11,
    fontWeight: 600,
    color: "#0d1117",
    background: MissionStatusColors[status] ?? "#8b949e",
});

function MissionCard({ mission }: { mission: MissionSnapshot }) {
    return (
        <div style={{ border: "1px solid #30363d", borderRadius: 6, padding: 10, marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span style={statusChip(mission.status)}>{mission.status.toUpperCase()}</span>
                <span style={{ fontWeight: 600 }}>{mission.objective}</span>
            </div>
            <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}>
                target: {mission.execution_target || "?"} · DoD {dodProgress(mission)}
                {mission.strategy ? ` · estrategia: ${mission.strategy}` : ""}
            </div>
            {mission.workers.length > 0 && (
                <table style={{ fontSize: 12, width: "100%", marginBottom: 6 }}>
                    <tbody>
                        {mission.workers.map((w) => (
                            <tr key={w.id}>
                                <td style={{ paddingRight: 10 }}>{w.agent}</td>
                                <td style={{ paddingRight: 10 }}>{w.role}</td>
                                <td style={{ paddingRight: 10, color: "#58a6ff" }}>
                                    {w.execution_host || "local"}
                                    {w.transport === "ssh" ? " (ssh)" : ""}
                                </td>
                                <td>{WorkerStatusLabels[w.status] ?? w.status}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {mission.needs_attention && (
                <div style={{ fontSize: 12, color: "#f85149", marginBottom: 4 }}>
                    ⚠ Necesita atención: {mission.needs_attention}
                </div>
            )}
            <div style={{ fontSize: 12, color: "#8b949e" }}>
                Última decisión: {lastDecisionText(mission)}
            </div>
        </div>
    );
}

function JarvisView({ model }: ViewComponentProps<JarvisViewModel>) {
    const missions = useAtomValue(model.missionsAtom);
    const error = useAtomValue(model.errorAtom);
    const loading = useAtomValue(model.loadingAtom);
    const summary = summarizeMissions(missions);

    return (
        <div style={{ padding: 12, overflowY: "auto", height: "100%", fontFamily: "var(--base-font)" }}>
            <div style={{ display: "flex", gap: 12, marginBottom: 10, fontSize: 12, color: "#8b949e" }}>
                <span>
                    Misiones activas: <b style={{ color: "#3fb950" }}>{summary.running}</b>
                </span>
                <span>
                    Necesitan atención: <b style={{ color: summary.needsAttention ? "#f85149" : "#8b949e" }}>{summary.needsAttention}</b>
                </span>
            </div>
            {error != null && (
                <div style={{ color: "#d29922", fontSize: 12, marginBottom: 8 }}>{error}</div>
            )}
            {loading && missions.length === 0 && <div style={{ fontSize: 12 }}>Cargando…</div>}
            {!loading && missions.length === 0 && error == null && (
                <div style={{ fontSize: 12, color: "#8b949e" }}>
                    Sin misiones. Crear una: POST {"{brain}"}/missions o por voz/intent.
                </div>
            )}
            {missions.map((m) => (
                <MissionCard key={m.mission_id} mission={m} />
            ))}
        </div>
    );
}
