// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import {
    ActivitySource_AiPrefix,
    ActivitySummarizer,
    ActivitySummary,
    clampSummary,
    PanelContextSignal,
    sanitizePanelContext,
} from "./panelactivity-util";

// =============================================================================
// Smart Activity / AI Context — runtime pipeline (Phase G)
// =============================================================================
//
// The panel identity layer (see panelidentity.tsx) gives every panel a manual customTitle + note.
// This module is the *prepared* runtime for a future, opt-in, AI-generated "activity summary" — a
// short (4-8 word) description of the user's GOAL in a panel (e.g. "Implementando pipeline OSINT").
//
// Nothing here runs an inference on its own. The pipeline is:
//
//   Panel  ->  collectPanelContext  ->  sanitizePanelContext  ->  ActivitySummarizer  ->  writeActivitySummary
//              (existing meta only)      (strip secrets)          (registered later)       (frame:activity:*)
//
// A provider (OpenClaw / Nexus Provider Fabric / a local model) registers an ActivitySummarizer via
// registerActivitySummarizer(). Until one is registered, generatePanelActivitySummary() is a no-op
// and isActivitySummaryAvailable() returns false, so the UI shows no dead button.
//
// Design constraints baked in (see also nexus docs):
//   - event-driven / debounced in the future (panel created, significant web nav, cwd change, N
//     commands, idle period, manual refresh) — NOT per-frame / per-keystroke.
//   - privacy first: only existing metadata is collected today; the sanitizer is the mandatory gate
//     for when richer signals (recent commands, page text) are added later.
//   - per-panel opt-in via the "frame:activity:enabled" meta key (default off).

export * from "./panelactivity-util";

let registeredSummarizer: ActivitySummarizer = null;

export function registerActivitySummarizer(summarizer: ActivitySummarizer) {
    registeredSummarizer = summarizer;
}

export function isActivitySummaryAvailable(): boolean {
    return registeredSummarizer != null;
}

export function collectPanelContext(blockId: string): PanelContextSignal {
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    const meta = block?.meta ?? {};
    return {
        view: meta["view"] ?? "",
        customTitle: meta["frame:title"],
        note: meta["frame:note"],
        connection: meta["connection"],
        cwd: meta["cmd:cwd"],
        url: meta["url"],
    };
}

export function writeActivitySummary(blockId: string, summary: ActivitySummary) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", blockId),
            meta: {
                "frame:activity": summary.text === "" ? null : summary.text,
                "frame:activity:updatedat": summary.updatedAt,
                "frame:activity:source": summary.source,
            },
        })
    );
}

export function isActivityEnabled(blockId: string): boolean {
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    return block?.meta?.["frame:activity:enabled"] === true;
}

export function setActivityEnabled(blockId: string, enabled: boolean) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", blockId),
            meta: { "frame:activity:enabled": enabled ? true : null },
        })
    );
}

// The single entry point a UI action / future event-driven scheduler calls. No-op until a summarizer
// is registered. A manual call is treated as explicit user consent; automatic/event-driven capture
// should additionally require isActivityEnabled(blockId).
export async function generatePanelActivitySummary(blockId: string): Promise<string | null> {
    const summarizer = registeredSummarizer;
    if (summarizer == null) {
        return null;
    }
    const ctx = sanitizePanelContext(collectPanelContext(blockId));
    const raw = await summarizer.summarize(ctx);
    if (raw == null) {
        return null;
    }
    const text = clampSummary(raw);
    if (text === "") {
        return null;
    }
    const model = summarizer.modelName;
    writeActivitySummary(blockId, {
        text,
        updatedAt: Date.now(),
        source: ActivitySource_AiPrefix + (model ?? "unknown"),
    });
    return text;
}
