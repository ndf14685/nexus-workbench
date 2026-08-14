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
