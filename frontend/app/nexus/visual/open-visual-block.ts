// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Apertura del bloque HMI desde la botonera. Apretar HMI dos veces no puede
// dejar dos bloques mirando la misma capturadora: el device es exclusivo, así
// que el segundo bloque mostraría DEVICE_BUSY. Si ya existe, se enfoca.

import { atoms, createBlock, globalStore, WOS } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { MetaSourceKey } from "@/app/view/visual/visual-model";

export const VisualViewType = "visual";

// findVisualBlock es puro respecto del store: recibe los bloques ya leídos para
// poder testear la regla de deduplicación sin montar un tab.
export function findVisualBlock(
    blocks: { blockId: string; view?: string; sourceId?: string }[],
    sourceId?: string
): string | null {
    const visual = blocks.filter((b) => b.view === VisualViewType);
    if (visual.length === 0) {
        return null;
    }
    if (sourceId) {
        // Fuente explícita: sólo cuenta como duplicado el bloque que ya muestra
        // ESA fuente. Dos capturadoras distintas son dos bloques legítimos.
        const exact = visual.find((b) => b.sourceId === sourceId);
        if (exact) {
            return exact.blockId;
        }
        // Un bloque sin fuente fijada adopta la pedida en vez de duplicarse.
        const unbound = visual.find((b) => !b.sourceId);
        return unbound?.blockId ?? null;
    }
    return visual[0].blockId;
}

function currentTabBlocks(): { blockId: string; view?: string; sourceId?: string }[] {
    const tabId = globalStore.get(atoms.staticTabId);
    if (!tabId) {
        return [];
    }
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    const blockIds = tab?.blockids ?? [];
    return blockIds.map((blockId) => {
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        return {
            blockId,
            view: block?.meta?.view as string,
            sourceId: block?.meta?.[MetaSourceKey] as string,
        };
    });
}

// openOrFocusVisualBlock: el comportamiento del botón HMI. El alcance es el tab
// actual a propósito — un bloque HMI en otro monitor/tab no impide abrir uno
// acá, que es lo que el usuario espera cuando trabaja en varias pantallas.
export async function openOrFocusVisualBlock(sourceId?: string): Promise<string> {
    const existing = findVisualBlock(currentTabBlocks(), sourceId);
    if (existing) {
        const layoutModel = getLayoutModelForStaticTab();
        const node = layoutModel?.getNodeByBlockId(existing);
        if (node) {
            layoutModel.focusNode(node.id);
        }
        return existing;
    }
    const meta: MetaType = { view: VisualViewType };
    if (sourceId) {
        meta[MetaSourceKey] = sourceId;
    }
    return await createBlock({ meta });
}
