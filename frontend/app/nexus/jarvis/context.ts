// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { scrubSecrets } from "@/app/block/panelactivity-util";
import { atoms, getBlockComponentModel, getSettingsKeyAtom, globalStore, WOS } from "@/app/store/global";
import { normalizeAIVision, sourceLabel, visualSourcesAtom } from "@/app/nexus/visual/visual-types";
import { MetaSourceKey, type VisualSourceViewModel } from "@/app/view/visual/visual-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeFeBlockRouteId, makeTabRouteId } from "@/app/store/wshrouter";
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
    // Un bloque HMI enfocado. Es lo que resuelve la deixis: "mira esto" con el
    // HMI en foco apunta a ESTA fuente. Viaja metadata, nunca imagen: el frame
    // se pide despues por la capability visual.snapshot/observe.
    | {
          kind: "visual";
          blockid: string;
          sourceid: string;
          label: string;
          aivision: string;
          status: string;
          available?: boolean;
      }
    // El catalogo de fuentes visuales del Workbench. Va siempre (no depende del
    // foco) para que el cerebro pueda resolver "la pantalla del banco" por su
    // etiqueta aunque el bloque no este enfocado ni abierto.
    | {
          kind: "visual_sources";
          sources: JarvisVisualSource[];
      }
    | { kind: "empty" };

// El contexto del bloque enfocado siempre tiene blockid; el catalogo de fuentes
// no es un bloque. Separarlos en el tipo evita que el consumidor tenga que
// adivinar cual recibio.
export type JarvisFocusedContext = Extract<JarvisContextModule, { blockid: string }> | { kind: "empty" };

export interface JarvisVisualSource {
    id: string;
    label: string;
    type: string;
    ai_vision: string;
    visible: boolean;
    focused: boolean;
    status: string;
    available?: boolean;
}

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

async function captureTerminalContext(fbd: FocusedBlockData): Promise<JarvisFocusedContext> {
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
    const ctx: Extract<JarvisFocusedContext, { kind: "terminal" }> = { kind: "terminal", blockid: fbd.blockid, connection };
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

function captureWebContext(fbd: FocusedBlockData): JarvisFocusedContext {
    const meta = fbd.blockmeta ?? {};
    const url = (meta["url"] as string) ?? "";
    if (!url) {
        return { kind: "empty" };
    }
    const ctx: Extract<JarvisFocusedContext, { kind: "web" }> = { kind: "web", blockid: fbd.blockid, url };
    const title = (meta["nexus:web:title"] as string) ?? (meta["frame:title"] as string);
    if (title) ctx.title = title;
    try {
        ctx.domain = new URL(url).hostname;
    } catch {
        // url malformada: se manda igual, sin domain
    }
    return ctx;
}

// visualBlockState lee el estado real del viewer abierto (live/offline). Si el
// bloque no esta montado no se inventa nada: queda "unknown" y el cerebro puede
// preguntar por la capability visual.sources.list, que si mira el host.
function visualBlockState(blockId: string): { status: string; available?: boolean } {
    try {
        const vm = getBlockComponentModel(blockId)?.viewModel as VisualSourceViewModel;
        const state = vm?.stateAtom ? globalStore.get(vm.stateAtom) : null;
        if (state == null) {
            return { status: "unknown" };
        }
        return { status: state.status, available: state.status === "live" };
    } catch {
        return { status: "unknown" };
    }
}

function captureVisualContext(fbd: FocusedBlockData): JarvisFocusedContext {
    const meta = fbd.blockmeta ?? {};
    const sourceId = (meta[MetaSourceKey] as string) ?? "";
    const sources = globalStore.get(visualSourcesAtom);
    const source = sources.find((src) => src.id === sourceId) ?? sources[0];
    if (source == null) {
        return { kind: "empty" };
    }
    const state = visualBlockState(fbd.blockid);
    return {
        kind: "visual",
        blockid: fbd.blockid,
        sourceid: source.id,
        label: sourceLabel(source),
        aivision: normalizeAIVision(source.aivision),
        status: state.status,
        available: state.available,
    };
}

// captureVisualSources arma el catalogo con lo que el Workbench sabe: que
// fuentes hay configuradas, cuales estan visibles en un bloque y cual esta
// enfocada. La disponibilidad real del dispositivo la sabe el provider del
// host, no el renderer.
export function captureVisualSources(focusedBlockId?: string): JarvisContextModule {
    const sources = globalStore.get(visualSourcesAtom);
    if (sources.length === 0) {
        return { kind: "empty" };
    }
    const openBlocks = new Map<string, string>();
    try {
        const tabId = globalStore.get(atoms.staticTabId);
        const tab = tabId ? globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId))) : null;
        for (const blockId of tab?.blockids ?? []) {
            const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view !== "visual") {
                continue;
            }
            const bound = (block.meta[MetaSourceKey] as string) || sources[0]?.id;
            if (bound && !openBlocks.has(bound)) {
                openBlocks.set(bound, blockId);
            }
        }
    } catch {
        // sin tab legible el catalogo sigue siendo util: solo pierde visible/focused
    }
    return {
        kind: "visual_sources",
        sources: sources.map((src) => {
            const blockId = openBlocks.get(src.id);
            const state = blockId ? visualBlockState(blockId) : { status: "closed" as string, available: undefined };
            return {
                id: src.id,
                label: sourceLabel(src),
                type: src.type ?? "uvc",
                ai_vision: normalizeAIVision(src.aivision),
                visible: blockId != null,
                focused: blockId != null && blockId === focusedBlockId,
                status: state.status,
                available: state.available,
            };
        }),
    };
}

export async function captureFocusedContext(): Promise<JarvisFocusedContext> {
    let fbd: FocusedBlockData;
    try {
        // getfocusedblockdata solo lo implementa el TabRpcClient (tabrpcclient.ts); sin route
        // el call cae en el wshserver Go, que no lo conoce, y el contexto queda vacío.
        const tabRoute = makeTabRouteId(globalStore.get(atoms.staticTabId));
        fbd = await RpcApi.GetFocusedBlockDataCommand(TabRpcClient, { route: tabRoute, timeout: 3000 });
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
    if (fbd.viewtype == "visual") {
        return captureVisualContext(fbd);
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
    if (ctx.kind == "visual") {
        return ["HMI", ctx.label, ctx.status == "live" ? "live" : ctx.status].filter(Boolean).join(" · ");
    }
    if (ctx.kind == "visual_sources") {
        return `Fuentes visuales · ${ctx.sources.length}`;
    }
    return ["Web", ctx.domain ?? ctx.url, ctx.title].filter(Boolean).join(" · ");
}
