// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { getSpatialBus } from "./spatial-bus";
import { decideDockedFocusAction, decideDockedFocusReleaseAction, isDetachedModule } from "./spatial-model";

// Vive en archivo propio (no en spatial-model) para no crear el ciclo
// spatial-model → layoutModelHooks → layoutModel → spatial-model; además el
// grafo de imports de layoutModel no entra al vitest de spatial. Solo la
// ventana principal cablea esto (los surface renderers no tienen LayoutModel).

export function focusDockedModule(moduleId: string): void {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(moduleId);
    const action = decideDockedFocusAction(isDetachedModule(moduleId), node?.id, layoutModel?.magnifiedNodeId);
    if (action === "magnify") {
        layoutModel.magnifyNodeToggle(node.id);
    }
}

export function releaseDockedFocus(moduleId: string): void {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(moduleId);
    const action = decideDockedFocusReleaseAction(isDetachedModule(moduleId), node?.id, layoutModel?.magnifiedNodeId);
    if (action === "unmagnify") {
        layoutModel.magnifyNodeToggle(node.id);
    }
}

// "Maximizar módulo" acoplado = toggle plano de magnify: a diferencia de
// Focus NO captura FocusSnapshot ni pasa por el engine (CONTRACTS §7:
// Maximize acoplado = magnify; Focus = snapshot + module.focused).
export function toggleDockedMagnify(moduleId: string): void {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(moduleId);
    if (node == null) {
        return;
    }
    layoutModel.magnifyNodeToggle(node.id);
}

// module.focused/focusReleased → magnify/unmagnify del bloque si está
// acoplado en este tab (getNodeByBlockId null = no es de este tab → no-op).
export function wireDockedFocusHandlers(): () => void {
    const bus = getSpatialBus();
    const offFocused = bus.on("module.focused", (p) => focusDockedModule(p.moduleId));
    const offReleased = bus.on("module.focusReleased", (p) => releaseDockedFocus(p.moduleId));
    return () => {
        offFocused();
        offReleased();
    };
}
