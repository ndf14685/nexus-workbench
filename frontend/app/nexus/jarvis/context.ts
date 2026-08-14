// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { scrubSecrets } from "@/app/block/panelactivity-util";
import { getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeFeBlockRouteId } from "@/app/store/wshrouter";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { inferRepo } from "./repo-infer";

export type JarvisContextModule =
    | {
          kind: "terminal";
          blockid: string;
          title?: string;
          connection: string;
          cwd?: string;
          repo?: string;
          environmentid?: string;
          shellstate?: string;
          lastcommand?: string;
          lastexitcode?: number;
          recentoutput?: string;
          jarvismission?: string;
      }
    | {
          kind: "web";
          blockid: string;
          url: string;
          title?: string;
          domain?: string;
      }
    | { kind: "empty" };

const RecentOutputMaxChars = 4000;

async function captureRecentOutput(blockId: string): Promise<string> {
    try {
        const rtn = await RpcApi.TermGetScrollbackLinesCommand(
            TabRpcClient,
            { linestart: 0, lineend: 0, lastcommand: true },
            { route: makeFeBlockRouteId(blockId), timeout: 4000 }
        );
        const text = (rtn?.lines ?? []).join("\n").trim();
        if (!text) {
            return "";
        }
        return scrubSecrets(text.slice(-RecentOutputMaxChars));
    } catch {
        return "";
    }
}

async function captureTerminalContext(fbd: FocusedBlockData): Promise<JarvisContextModule> {
    const meta = fbd.blockmeta ?? {};
    const connection = fbd.connname ?? (meta["connection"] as string) ?? "";
    const cwd = meta["cmd:cwd"] as string;
    let rtInfo: ObjRTInfo = null;
    try {
        rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, { oref: `block:${fbd.blockid}` }, { timeout: 3000 });
    } catch {
        rtInfo = null;
    }
    let environments: NexusEnvType[] = [];
    try {
        environments = (globalStore.get(getSettingsKeyAtom("nexus:environments")) as NexusEnvType[]) ?? [];
    } catch {
        environments = [];
    }
    const inference = inferRepo(cwd ?? "", connection, environments);
    const recentOutput = await captureRecentOutput(fbd.blockid);
    const ctx: JarvisContextModule = { kind: "terminal", blockid: fbd.blockid, connection };
    if (meta["frame:title"]) ctx.title = meta["frame:title"] as string;
    if (cwd) ctx.cwd = cwd;
    if (inference.repo) ctx.repo = inference.repo;
    if (inference.environmentId) ctx.environmentid = inference.environmentId;
    if (rtInfo?.["shell:state"]) ctx.shellstate = rtInfo["shell:state"];
    const lastCommand = fbd.termlastcommand ?? rtInfo?.["shell:lastcmd"];
    if (lastCommand) ctx.lastcommand = scrubSecrets(lastCommand);
    if (rtInfo?.["shell:lastcmdexitcode"] != null) ctx.lastexitcode = rtInfo["shell:lastcmdexitcode"];
    if (recentOutput) ctx.recentoutput = recentOutput;
    if (meta["jarvis:mission"]) ctx.jarvismission = meta["jarvis:mission"] as string;
    return ctx;
}

function captureWebContext(fbd: FocusedBlockData): JarvisContextModule {
    const meta = fbd.blockmeta ?? {};
    const url = (meta["url"] as string) ?? "";
    if (!url) {
        return { kind: "empty" };
    }
    const ctx: JarvisContextModule = { kind: "web", blockid: fbd.blockid, url };
    const title = (meta["nexus:web:title"] as string) ?? (meta["frame:title"] as string);
    if (title) ctx.title = title;
    try {
        ctx.domain = new URL(url).hostname;
    } catch {
        // url malformada: se manda igual, sin domain
    }
    return ctx;
}

export async function captureFocusedContext(): Promise<JarvisContextModule> {
    let fbd: FocusedBlockData;
    try {
        fbd = await RpcApi.GetFocusedBlockDataCommand(TabRpcClient, { timeout: 3000 });
    } catch {
        return { kind: "empty" };
    }
    if (!fbd?.blockid) {
        return { kind: "empty" };
    }
    if (fbd.viewtype == "term") {
        return await captureTerminalContext(fbd);
    }
    if (fbd.viewtype == "web") {
        return captureWebContext(fbd);
    }
    return { kind: "empty" };
}

export function describeContext(ctx: JarvisContextModule): string {
    if (ctx == null || ctx.kind == "empty") {
        return "sin contexto";
    }
    if (ctx.kind == "terminal") {
        const parts = ["Terminal"];
        parts.push(ctx.connection || "local");
        if (ctx.repo) {
            parts.push(ctx.repo.split("/").pop());
        } else if (ctx.cwd) {
            parts.push(ctx.cwd);
        }
        return parts.join(" · ");
    }
    return ["Web", ctx.domain ?? ctx.url, ctx.title].filter(Boolean).join(" · ");
}
