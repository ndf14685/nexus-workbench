// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Live bindings for brain-invoked workspace capabilities: the real spatial
// `workspace.*` facade plus a module resolver over Wave's stores. Kept out of
// jarvis-capabilities.ts (pure) and loaded lazily by HttpJarvisRuntime so the
// runtime's unit tests never drag in the Wave store graph.

import { globalStore } from "@/app/store/jotaiStore";
import { atoms, WOS } from "@/store/global";
import { workspace } from "../spatial/spatial-api";
import { WorkspaceFacade } from "./jarvis-capabilities";

export const liveWorkspaceFacade: WorkspaceFacade = workspace;

const UuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves a brain-sent module reference: a blockId passes through directly
// (UUIDs are trusted even if not in the active tab: detached modules or other
// tabs; the spatial RPC errors honestly if the block does not exist), a
// friendly module type ("term", "jarvis", …) resolves to the first block of
// that view type in the active tab. Detached modules stay in tab.blockids
// (CONTRACTS §6), so the active-tab scan covers them too.
export function resolveModuleRef(ref: string): string | null {
    if (!ref) {
        return null;
    }
    if (UuidRegex.test(ref)) {
        return ref;
    }
    try {
        const tabId = globalStore.get(atoms.staticTabId);
        if (!tabId) {
            return null;
        }
        const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        for (const blockId of tab?.blockids ?? []) {
            const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === ref) {
                return blockId;
            }
        }
    } catch (e) {
        console.error("jarvis-capabilities-live: module resolution failed", e);
    }
    return null;
}
