// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { atoms, globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { jarvisLog } from "./telemetry";

export interface ParkedEntry {
    blockid: string;
    title: string;
    kind: string;
    note?: string;
    parkedAt?: number;
    url?: string;
}

export async function parkBlock(blockId: string, note?: string): Promise<void> {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel.getNodeByBlockId(blockId);
    if (node != null) {
        layoutModel.removeNodeKeepBlock(node.id);
    }
    await RpcApi.ParkBlockCommand(TabRpcClient, { blockid: blockId, note: note ?? "" });
    jarvisLog("jarvis.park", { blockId, hadNode: node != null });
}

export async function restorePark(blockId: string): Promise<string> {
    const activeTabId = globalStore.get(atoms.staticTabId);
    const tabId = await RpcApi.UnparkBlockCommand(TabRpcClient, { blockid: blockId, tabid: activeTabId });
    jarvisLog("jarvis.restore", { blockId, tabId });
    return tabId;
}

export async function closeParked(blockId: string): Promise<void> {
    await RpcApi.DeleteBlockCommand(TabRpcClient, { blockid: blockId });
}

export async function listParked(): Promise<ParkedEntry[]> {
    const parked = (await RpcApi.ListParkedBlocksCommand(TabRpcClient)) ?? [];
    return parked.map((entry) => {
        const meta = entry.meta ?? {};
        const view = (meta["view"] as string) ?? "";
        const title =
            (meta["frame:title"] as string) ||
            (meta["nexus:web:title"] as string) ||
            (meta["url"] as string) ||
            (meta["cmd:cwd"] as string) ||
            view ||
            entry.blockid;
        return {
            blockid: entry.blockid,
            title,
            kind: view,
            note: (meta["nexus:parked:note"] as string) || undefined,
            parkedAt: (meta["nexus:parked:at"] as number) || undefined,
            url: (meta["url"] as string) || undefined,
        };
    });
}

const ParkTriggers = ["guarda esto para despues", "guardalo para despues", "guardame esto", "parkealo", "parkea esto"];

export function matchParkIntent(text: string): boolean {
    const norm = text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    return ParkTriggers.some((t) => norm.includes(t));
}
