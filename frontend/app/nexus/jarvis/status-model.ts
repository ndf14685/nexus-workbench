// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { getBrainConfig } from "./brain-config";
import { fetchMissions } from "./brain-client";
import { jarvisLog } from "./telemetry";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

export interface MissionSnapshot {
    mission_id: string;
    name?: string;
    objective?: string;
    status: string;
    repo?: string;
    execution_target?: string;
    result_summary?: string;
    needs_attention?: string;
    updated_at?: number;
    workers?: { id: string; block_id?: string; status: string; role: string }[];
}

const PollMs = 3000;
const WorkingStatuses = ["running", "recovering"];
const AttentionStatuses = ["needs_input", "blocked"];
// estados que merecen interrumpir al usuario (§8: solo atención real, jamás pasos)
const NotifyStatuses = ["completed", "failed", "needs_input", "blocked"];

export function missionLabel(m: MissionSnapshot): string {
    return m.name || m.objective?.slice(0, 40) || m.mission_id;
}

export interface MissionNotification {
    missionId: string;
    title: string;
    body: string;
    status: string;
}

// puro: transición de estados entre dos polls → notificaciones a emitir.
// prev vacío (primer poll / arranque) no notifica: el estado ya era conocido
// por el usuario o es histórico.
export function computeTransitions(
    prev: Map<string, string>,
    missions: MissionSnapshot[]
): MissionNotification[] {
    if (prev.size == 0) {
        return [];
    }
    const out: MissionNotification[] = [];
    for (const mission of missions) {
        const before = prev.get(mission.mission_id);
        if (before == null || before == mission.status) {
            continue;
        }
        if (!NotifyStatuses.includes(mission.status)) {
            continue;
        }
        const label = missionLabel(mission);
        if (mission.status == "completed") {
            out.push({
                missionId: mission.mission_id,
                title: `✓ ${label}`,
                body: mission.result_summary || "Misión terminada.",
                status: mission.status,
            });
        } else if (mission.status == "failed") {
            out.push({
                missionId: mission.mission_id,
                title: `✗ ${label}`,
                body: mission.needs_attention || "La misión falló.",
                status: mission.status,
            });
        } else {
            out.push({
                missionId: mission.mission_id,
                title: `Jarvis necesita tu decisión: ${label}`,
                body: mission.needs_attention || "Revisá el panel Jarvis.",
                status: mission.status,
            });
        }
    }
    return out;
}

export function summarizeCounts(missions: MissionSnapshot[]): { working: number; attention: number } {
    return {
        working: missions.filter((m) => WorkingStatuses.includes(m.status)).length,
        attention: missions.filter((m) => AttentionStatuses.includes(m.status)).length,
    };
}

export class JarvisStatusModel {
    private static instance: JarvisStatusModel = null;

    missionsAtom = jotai.atom<MissionSnapshot[]>([]);
    availableAtom = jotai.atom(false);
    workingCountAtom!: jotai.Atom<number>;
    attentionCountAtom!: jotai.Atom<number>;

    lastStatuses: Map<string, string> = new Map();
    timer: ReturnType<typeof setInterval> = null;

    private constructor() {
        this.workingCountAtom = jotai.atom((get) => summarizeCounts(get(this.missionsAtom)).working);
        this.attentionCountAtom = jotai.atom((get) => summarizeCounts(get(this.missionsAtom)).attention);
    }

    static getInstance(): JarvisStatusModel {
        if (!JarvisStatusModel.instance) {
            JarvisStatusModel.instance = new JarvisStatusModel();
        }
        return JarvisStatusModel.instance;
    }

    static resetInstance(): void {
        JarvisStatusModel.instance = null;
    }

    start() {
        if (this.timer != null) {
            return;
        }
        this.timer = setInterval(() => void this.poll(), PollMs);
        void this.poll();
    }

    stop() {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async poll() {
        const cfg = await getBrainConfig();
        if (!cfg.token) {
            globalStore.set(this.availableAtom, false);
            return;
        }
        let missions: MissionSnapshot[];
        try {
            missions = (await fetchMissions()) as unknown as MissionSnapshot[];
        } catch {
            globalStore.set(this.availableAtom, false);
            return;
        }
        globalStore.set(this.availableAtom, true);
        globalStore.set(this.missionsAtom, missions);
        const notifications = computeTransitions(this.lastStatuses, missions);
        this.lastStatuses = new Map(missions.map((m) => [m.mission_id, m.status]));
        for (const notification of notifications) {
            this.notify(notification);
        }
    }

    notify(notification: MissionNotification) {
        jarvisLog(
            notification.status == "completed" || notification.status == "failed"
                ? "jarvis.mission.complete"
                : "jarvis.user_attention.required",
            { missionId: notification.missionId, status: notification.status }
        );
        void RpcApi.NotifyCommand(TabRpcClient, {
            title: notification.title,
            body: notification.body.slice(0, 300),
            silent: false,
        }).catch(() => {});
    }

    missionForBlock(blockId: string, missions: MissionSnapshot[]): MissionSnapshot {
        const needle = `block:${blockId}`;
        return missions.find((m) => (m.workers ?? []).some((w) => w.block_id == needle || w.block_id == blockId));
    }
}
