// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { modalsModel } from "@/store/modalmodel";
import { fireAndForget } from "@/util/util";
import { workspace } from "./spatial-api";
import { hasFocusSnapshot, isDetachedModule, SpatialModel } from "./spatial-model";

// Imports dinámicos en los click handlers: spatial-focus arrastra el grafo de
// layoutModel y getApi() exige entorno Electron; ninguno debe entrar al
// grafo estático de este archivo (lo importa el vitest de spatial).
function makeFocusItems(blockId: string, detached: boolean): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
        {
            label: "Enfocar módulo",
            click: () =>
                fireAndForget(async () => {
                    await RpcApi.SpatialFocusCommand(TabRpcClient, { moduleid: blockId });
                }),
        },
    ];
    if (hasFocusSnapshot(blockId)) {
        items.push({
            label: "Restaurar posición anterior",
            click: () =>
                fireAndForget(async () => {
                    await RpcApi.SpatialRestoreCommand(TabRpcClient, { moduleid: blockId });
                }),
        });
    }
    items.push({
        label: "Maximizar módulo",
        click: () =>
            fireAndForget(async () => {
                if (detached) {
                    (await import("@/app/store/global")).getApi().spatialToggleMaximize();
                } else {
                    (await import("./spatial-focus")).toggleDockedMagnify(blockId);
                }
            }),
    });
    if (detached) {
        items.push({
            label: "Minimizar módulo",
            click: () =>
                fireAndForget(async () => {
                    await RpcApi.SpatialSetMinimizedCommand(TabRpcClient, { moduleid: blockId, minimized: true });
                }),
        });
    }
    return items;
}

function monitorDisplayLabel(monitor: MonitorInfo): string {
    const base = monitor.label || `Monitor ${monitor.displayid}`;
    return monitor.primary ? `${base} (principal)` : base;
}

// Helper puro (testeable sin RPC): un ítem por monitor, marcador
// "(principal)", el monitor actual del módulo deshabilitado.
export function buildMonitorSubmenu(
    monitors: MonitorInfo[],
    currentMonitorId: string,
    onSelect: (monitorId: string) => void
): ContextMenuItem[] {
    return (monitors ?? []).map((monitor) => ({
        label: monitorDisplayLabel(monitor),
        enabled: monitor.monitorid !== currentMonitorId,
        click: () => onSelect(monitor.monitorid),
    }));
}

// Helper puro (testeable sin RPC): un ítem por perfil existente; lista
// vacía o ausente → único ítem deshabilitado "(sin perfiles)".
export function buildProfileSubmenu(profiles: string[], onSelect: (name: string) => void): ContextMenuItem[] {
    if (profiles == null || profiles.length === 0) {
        return [{ label: "(sin perfiles)", enabled: false }];
    }
    return profiles.map((name) => ({ label: name, click: () => onSelect(name) }));
}

// Confirmación del modal de guardado (extraída del componente para poder
// testear el flujo sin montar React).
export async function saveProfileAs(name: string): Promise<void> {
    await workspace.saveLayout(name);
    console.log(`spatial: perfil '${name}' guardado`);
}

function makeProfileItems(profiles: string[]): ContextMenuItem[] {
    return [
        { type: "separator" },
        {
            label: "Guardar layout como perfil…",
            click: () => modalsModel.pushModal("SpatialSaveProfileModal"),
        },
        {
            label: "Cargar perfil",
            type: "submenu",
            submenu: buildProfileSubmenu(profiles, (name) => fireAndForget(() => workspace.loadLayout(name))),
        },
    ];
}

// Ítems espaciales del menú del block header (CONTRACTS §7). Visibilidad:
// Pop Out solo con el módulo acoplado; Pop In (que en el MVP también cubre
// "Move to Main Window") solo detached; Mover a monitor solo detached y con
// catálogo disponible (se OMITE en vez de mostrarse deshabilitado). Cerrar
// módulo (detached) usa SpatialCloseModuleCommand — cerrar la ventana sigue
// siendo Pop In (R12); cerrar acoplado ya existe como "Close Block" estándar.
// La sección de perfiles (guardar/cargar) va al final y es SIEMPRE visible.
export function buildSpatialMenuItems(blockId: string, monitors?: MonitorInfo[], profiles?: string[]): ContextMenuItem[] {
    if (!isDetachedModule(blockId)) {
        return [
            {
                label: "Desacoplar (Pop Out)",
                click: () =>
                    fireAndForget(async () => {
                        await RpcApi.SpatialDetachCommand(TabRpcClient, { moduleid: blockId });
                    }),
            },
            ...makeFocusItems(blockId, false),
            ...makeProfileItems(profiles),
        ];
    }
    const items: ContextMenuItem[] = [
        {
            label: "Acoplar a ventana principal",
            click: () =>
                fireAndForget(async () => {
                    await RpcApi.SpatialAttachCommand(TabRpcClient, { moduleid: blockId });
                }),
        },
    ];
    if (monitors?.length > 0) {
        items.push({
            label: "Mover a monitor",
            type: "submenu",
            submenu: buildMonitorSubmenu(monitors, SpatialModel.getInstance().getModuleMonitorId(blockId), (monitorId) =>
                fireAndForget(async () => {
                    await RpcApi.SpatialMoveCommand(TabRpcClient, { moduleid: blockId, monitorid: monitorId });
                })
            ),
        });
    }
    items.push(...makeFocusItems(blockId, true));
    items.push({
        label: "Cerrar módulo",
        click: () =>
            fireAndForget(async () => {
                await RpcApi.SpatialCloseModuleCommand(TabRpcClient, { moduleid: blockId });
            }),
    });
    items.push(...makeProfileItems(profiles));
    return items;
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
export function applySpatialMenu(
    menu: ContextMenuItem[],
    blockId: string,
    monitors?: MonitorInfo[],
    profiles?: string[]
): ContextMenuItem[] {
    let base = menu;
    if (isDetachedModule(blockId)) {
        base = base.filter((item) => !NonApplicableWhenDetached.has(item.label));
    }
    const spatialItems = buildSpatialMenuItems(blockId, monitors, profiles);
    if (spatialItems.length === 0) {
        return pruneConsecutiveSeparators(base);
    }
    return pruneConsecutiveSeparators([...base, { type: "separator" }, ...spatialItems]);
}

// Variante para el hook real: el submenu de monitores necesita el catálogo
// (RPC al cache del engine) y el de perfiles la lista persistida; si una
// RPC falla el menú sale sin ese submenu ("(sin perfiles)" en el caso de
// perfiles).
export async function applySpatialMenuAsync(menu: ContextMenuItem[], blockId: string): Promise<ContextMenuItem[]> {
    let monitors: MonitorInfo[] = null;
    if (isDetachedModule(blockId)) {
        try {
            monitors = await RpcApi.SpatialListMonitorsCommand(TabRpcClient);
        } catch (e) {
            console.error("spatial-menu: listing monitors failed", e);
        }
    }
    let profiles: string[] = null;
    try {
        profiles = await workspace.listLayouts();
    } catch (e) {
        console.error("spatial-menu: listing profiles failed", e);
    }
    return applySpatialMenu(menu, blockId, monitors, profiles);
}
