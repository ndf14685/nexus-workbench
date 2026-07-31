// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { isDetachedModule } from "./spatial-model";

// Ítems espaciales del menú del block header (CONTRACTS §7). Visibilidad:
// Pop Out solo con el módulo acoplado; Pop In (que en el MVP también cubre
// "Move to Main Window") solo detached. Focus / Move to Monitor / Minimize /
// Maximize / Return llegan con Tasks 9-10 y se OMITEN en vez de mostrarse
// deshabilitados (nada de UI muerta). Cerrar acoplado ya existe como
// "Close Block" estándar; cerrar desde detached requiere soporte del engine
// (orden serializado attach+delete) y queda para Tasks 9-10 — mientras tanto
// cerrar la ventana = Pop In y nunca se pierde el módulo (R12).
export function buildSpatialMenuItems(blockId: string): ContextMenuItem[] {
    if (!isDetachedModule(blockId)) {
        return [
            {
                label: "Desacoplar (Pop Out)",
                click: () =>
                    fireAndForget(async () => {
                        await RpcApi.SpatialDetachCommand(TabRpcClient, { moduleid: blockId });
                    }),
            },
        ];
    }
    return [
        {
            label: "Acoplar a ventana principal",
            click: () =>
                fireAndForget(async () => {
                    await RpcApi.SpatialAttachCommand(TabRpcClient, { moduleid: blockId });
                }),
        },
    ];
}

// Acciones tab-céntricas del menú estándar que no aplican dentro de una
// ventana detached (R11): magnify es no-op ahí y "Close Block" pasaría por
// uxCloseBlock/LayoutModel del tab, que en un surface renderer podría crear
// un drenador de PendingBackendActions competidor (R2) o cerrar el tab.
const NonApplicableWhenDetached = new Set(["Magnify Block", "Un-Magnify Block", "Close Block"]);

function pruneConsecutiveSeparators(menu: ContextMenuItem[]): ContextMenuItem[] {
    const out: ContextMenuItem[] = [];
    for (const item of menu) {
        if (item.type === "separator" && (out.length === 0 || out[out.length - 1].type === "separator")) {
            continue;
        }
        out.push(item);
    }
    while (out.length > 0 && out[out.length - 1].type === "separator") {
        out.pop();
    }
    return out;
}

// Punto único de entrada para el hook del block header: agrega los ítems
// espaciales y, si el módulo está detached, poda las acciones no aplicables.
export function applySpatialMenu(menu: ContextMenuItem[], blockId: string): ContextMenuItem[] {
    let base = menu;
    if (isDetachedModule(blockId)) {
        base = base.filter((item) => !NonApplicableWhenDetached.has(item.label));
    }
    const spatialItems = buildSpatialMenuItems(blockId);
    if (spatialItems.length === 0) {
        return pruneConsecutiveSeparators(base);
    }
    return pruneConsecutiveSeparators([...base, { type: "separator" }, ...spatialItems]);
}
