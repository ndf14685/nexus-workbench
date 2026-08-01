// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// WorkbenchContextProvider: the bridge that feeds Workbench state into Jarvis.
// This is the ONLY Jarvis module that may import Wave frontend internals.
// Fields it cannot resolve cheaply today stay undefined (repository, branch,
// project, selectedText) — the interface is complete, the sources are staged.

import { FocusManager } from "@/app/store/focusManager";
import { globalStore } from "@/app/store/jotaiStore";
import { atoms, getApi, getSettingsKeyAtom, WOS } from "@/store/global";
import { findEnvByConn } from "../envsidebar-util";
import { JarvisBrainConfig, JarvisBrainEnv, resolveBrainConfig } from "./jarvis-brain-config";
import { JarvisBus } from "./jarvis-bus";
import { WorkbenchContext } from "./jarvis-types";

const BrainSettingKeys = ["nexus:jarvisbrainenabled", "nexus:jarvisbrainurl", "nexus:jarvisbraintoken"] as const;

let cachedBrainEnv: JarvisBrainEnv = {};

// El renderer no puede leer process.env: emain expone exactamente las dos
// variables del cerebro (get-jarvis-brain-env). Se resuelve una vez al arranque
// y queda cacheada; quien la pida antes ve {} y vuelve a resolver después.
export async function loadJarvisBrainEnv(): Promise<JarvisBrainEnv> {
    try {
        const env = await getApi()?.getJarvisBrainEnv?.();
        cachedBrainEnv = { url: env?.url ?? "", token: env?.token ?? "" };
    } catch (e) {
        console.error("jarvis-context: error reading brain env", e);
    }
    return cachedBrainEnv;
}

// Brain endpoint settings (ADR-0007). Read here — not in jarvis-core — because
// this is the only Jarvis module allowed to import Wave internals (ADR-0005).
// La precedencia (setting > env > default) vive en jarvis-brain-config.
export function getJarvisBrainConfig(): JarvisBrainConfig {
    try {
        return resolveBrainConfig(
            {
                enabled: globalStore.get(getSettingsKeyAtom("nexus:jarvisbrainenabled")),
                url: globalStore.get(getSettingsKeyAtom("nexus:jarvisbrainurl")),
                token: globalStore.get(getSettingsKeyAtom("nexus:jarvisbraintoken")),
            },
            cachedBrainEnv
        );
    } catch (e) {
        console.error("jarvis-context: error reading brain settings", e);
        return resolveBrainConfig({}, cachedBrainEnv);
    }
}

// El watcher de config ya empuja los settings al frontend (fullConfigAtom); acá
// solo escuchamos las 3 claves del cerebro para no reconfigurar el runtime cada
// vez que cambia cualquier otro setting.
export function subscribeJarvisBrainSettings(onChange: () => void): () => void {
    const unsubs = BrainSettingKeys.map((key) => globalStore.sub(getSettingsKeyAtom(key), onChange));
    return () => unsubs.forEach((unsub) => unsub());
}

export class WorkbenchContextProvider {
    private unsubscribe: (() => void) | null = null;
    private lastSnapshot = "";

    constructor(private bus: JarvisBus) {}

    getContext(): WorkbenchContext {
        const ctx: WorkbenchContext = {};
        try {
            const ws = globalStore.get(atoms.workspace);
            ctx.workspace = ws?.name ?? undefined;
            const blockId = globalStore.get(FocusManager.getInstance().blockFocusAtom);
            if (blockId) {
                const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
                const conn = block?.meta?.connection ?? "";
                ctx.host = conn === "" ? "local" : conn;
                if (block?.meta?.view === "term") {
                    ctx.terminalBlockId = blockId;
                    ctx.workingDirectory = (block.meta?.["cmd:cwd"] as string) ?? undefined;
                }
                if (block?.meta?.view === "preview") {
                    ctx.selectedFile = (block.meta?.file as string) ?? undefined;
                }
                const envs = globalStore.get(getSettingsKeyAtom("nexus:environments")) ?? [];
                ctx.environment = findEnvByConn(envs, conn)?.id ?? undefined;
            }
        } catch (e) {
            console.error("jarvis-context: error building context", e);
        }
        return ctx;
    }

    // Watches focus changes and emits jarvis.contextChanged when the visible
    // context actually differs.
    start(): void {
        if (this.unsubscribe != null) {
            return;
        }
        this.unsubscribe = globalStore.sub(FocusManager.getInstance().blockFocusAtom, () => {
            const ctx = this.getContext();
            const snapshot = JSON.stringify(ctx);
            if (snapshot !== this.lastSnapshot) {
                this.lastSnapshot = snapshot;
                this.bus.emit("jarvis.contextChanged", ctx);
            }
        });
    }

    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
