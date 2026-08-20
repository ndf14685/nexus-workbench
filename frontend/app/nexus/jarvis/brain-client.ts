// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { getBrainConfig } from "./brain-config";
import type { JarvisContextModule } from "./context";

export interface IntentResponse {
    handled: boolean;
    response: string;
    needs_confirmation: boolean;
    metadata: Record<string, unknown>;
}

const IntentTimeoutMs = 45000;

export async function postIntent(text: string, contexts: JarvisContextModule[]): Promise<IntentResponse> {
    const { url, token } = await getBrainConfig();
    const resp = await fetch(`${url}/intent`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text, source: "workbench", contexts }),
        signal: AbortSignal.timeout(IntentTimeoutMs),
    });
    if (!resp.ok) {
        throw new Error(`el cerebro respondió ${resp.status}`);
    }
    const data = await resp.json();
    return {
        handled: !!data.handled,
        response: String(data.response ?? ""),
        needs_confirmation: !!data.needs_confirmation,
        metadata: data.metadata ?? {},
    };
}

export interface InboxMessage {
    timestamp: number;
    text: string;
}

// respuestas async del cerebro (jobs LLM que terminaron después del "Pensando…");
// jarvisd las rutea al inbox por cliente y NO las consume: cada frontend las lee
export async function fetchInbox(): Promise<InboxMessage[]> {
    const { url, token } = await getBrainConfig();
    const resp = await fetch(`${url}/inbox?client=workbench`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
        throw new Error(`el cerebro respondió ${resp.status}`);
    }
    const data = await resp.json();
    const responses = Array.isArray(data.responses) ? data.responses : [];
    return responses.map((r: Record<string, unknown>) => ({
        timestamp: Number(r.timestamp) || 0,
        text: String(r.text ?? ""),
    }));
}

export async function fetchMissions(): Promise<Record<string, unknown>[]> {
    const { url, token } = await getBrainConfig();
    const resp = await fetch(`${url}/missions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
        throw new Error(`el cerebro respondió ${resp.status}`);
    }
    const data = await resp.json();
    return Array.isArray(data.missions) ? data.missions : [];
}

// -- Personal Operations Layer (jarvisd v1.6) ------------------------------------
// El Workbench NO prioriza: consume la decisión ya tomada por el Attention
// Broker del cerebro. Una sola autoridad de atención para todas las superficies.

export interface NeedsYouEntry {
    work_item_id: string;
    title: string;
    next_action: string;
    reason: string;
    domain: string;
    project: string;
    due_at: number | null;
    approval_required: boolean;
    can_delegate: boolean;
    score: number;
}

export interface TodayView {
    operator_state: string;
    needs_you: NeedsYouEntry[];
    needs_you_total: number;
    running: number;
    running_items: { work_item_id: string; title: string; project: string }[];
    done_for_you: number;
    done_for_you_items: { work_item_id: string; title: string; summary: string }[];
    watching: number;
    watching_items: { work_item_id: string; title: string; domain: string }[];
    quiet: boolean;
    message: string;
    budget_remaining: number;
}

async function operatorFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const { url, token } = await getBrainConfig();
    const resp = await fetch(`${url}${path}`, {
        ...init,
        headers: {
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
        throw new Error(`el cerebro respondió ${resp.status}`);
    }
    return await resp.json();
}

export async function fetchToday(): Promise<TodayView> {
    return (await operatorFetch("/operator/today")) as unknown as TodayView;
}

export async function setOperatorState(state: string): Promise<Record<string, unknown>> {
    return await operatorFetch("/operator/state", {
        method: "POST",
        body: JSON.stringify({ state, source: "workbench" }),
    });
}

export async function resolveWorkItem(workItemId: string): Promise<Record<string, unknown>> {
    return await operatorFetch(`/operator/items/${workItemId}/resolve`, {
        method: "POST",
        body: JSON.stringify({}),
    });
}

export async function dismissWorkItem(workItemId: string): Promise<Record<string, unknown>> {
    return await operatorFetch(`/operator/items/${workItemId}/dismiss`, {
        method: "POST",
        body: JSON.stringify({}),
    });
}
