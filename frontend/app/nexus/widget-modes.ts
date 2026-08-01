// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Un widget por herramienta: en vez de un botón por variante de invocación
// (claude / claude --dangerously-skip-permissions / codex / codex --yolo), el
// catálogo declara `modes` y el importador los proyecta a esta clave de meta.

export const WidgetModesMetaKey = "nexus:modes";

export type NexusWidgetMode = {
    label: string;
    command: string;
    danger?: boolean;
};

// Los menús nativos de Electron no admiten color ni estilo por item: el prefijo
// es la única marca honesta disponible para distinguir un modo peligroso.
export const DangerLabelPrefix = "⚠ ";

export function parseWidgetModes(blockdef: BlockDef): NexusWidgetMode[] {
    const raw = blockdef?.meta?.[WidgetModesMetaKey];
    if (!Array.isArray(raw)) {
        return [];
    }
    const modes: NexusWidgetMode[] = [];
    for (const entry of raw) {
        if (entry == null || typeof entry !== "object") {
            continue;
        }
        const label = entry["label"];
        const command = entry["command"];
        if (typeof label !== "string" || typeof command !== "string") {
            continue;
        }
        if (label.trim() === "" || command.trim() === "") {
            continue;
        }
        const mode: NexusWidgetMode = { label, command };
        if (entry["danger"] === true) {
            mode.danger = true;
        }
        modes.push(mode);
    }
    return modes;
}

export function modeMenuLabel(mode: NexusWidgetMode): string {
    if (!mode.danger) {
        return mode.label;
    }
    return DangerLabelPrefix + mode.label;
}

export function blockDefForMode(blockdef: BlockDef, mode: NexusWidgetMode): BlockDef {
    const meta = { ...(blockdef?.meta ?? {}) };
    meta["cmd"] = mode.command;
    delete meta[WidgetModesMetaKey];
    return { ...blockdef, meta };
}

// Un `mode` solo puede cambiar el COMANDO de un bloque terminal. Una `action`
// es la forma general: lleva el meta completo del bloque a abrir, así un mismo
// botón puede ofrecer un chat web y un CLI en terminal (D-032).
export const WidgetActionsMetaKey = "nexus:actions";

export type NexusWidgetAction = {
    label: string;
    meta: MetaType;
    danger?: boolean;
    separatorBefore?: boolean;
};

export function parseWidgetActions(blockdef: BlockDef): NexusWidgetAction[] {
    const raw = blockdef?.meta?.[WidgetActionsMetaKey];
    if (!Array.isArray(raw)) {
        return [];
    }
    const actions: NexusWidgetAction[] = [];
    for (const entry of raw) {
        if (entry == null || typeof entry !== "object") {
            continue;
        }
        const label = entry["label"];
        const meta = entry["meta"];
        if (typeof label !== "string" || label.trim() === "" || meta == null || typeof meta !== "object") {
            continue;
        }
        const action: NexusWidgetAction = { label, meta };
        if (entry["danger"] === true) {
            action.danger = true;
        }
        if (entry["separatorBefore"] === true) {
            action.separatorBefore = true;
        }
        actions.push(action);
    }
    return actions;
}

export function blockDefForAction(action: NexusWidgetAction): BlockDef {
    const meta = { ...action.meta };
    delete meta[WidgetActionsMetaKey];
    delete meta[WidgetModesMetaKey];
    return { meta };
}

export function buildActionMenuItems(
    blockdef: BlockDef,
    onSelect: (blockdef: BlockDef, action: NexusWidgetAction) => void,
    opts?: { title?: string }
): ContextMenuItem[] {
    const actions = parseWidgetActions(blockdef);
    if (actions.length < 2) {
        return [];
    }
    const items: ContextMenuItem[] = [];
    for (const action of actions) {
        if (action.separatorBefore && items.length > 0) {
            items.push({ type: "separator" });
        }
        items.push({
            label: action.danger ? DangerLabelPrefix + action.label : action.label,
            click: () => onSelect(blockDefForAction(action), action),
        });
    }
    if (opts?.title) {
        items.unshift({ label: opts.title, enabled: false }, { type: "separator" });
    }
    return items;
}

// Devuelve [] cuando no hay ambigüedad que resolver (0 o 1 modo): el llamador
// cae al comportamiento normal de crear el bloque directamente.
//
// `opts.title` agrega un encabezado deshabilitado + separador para que el menú
// diga de qué herramienta se está eligiendo el modo. Se usa `enabled: false` y
// no `type: "header"`: el tipo header solo se renderiza como tal en macOS.
export function buildModeMenuItems(
    blockdef: BlockDef,
    onSelect: (blockdef: BlockDef, mode: NexusWidgetMode) => void,
    opts?: { title?: string }
): ContextMenuItem[] {
    const modes = parseWidgetModes(blockdef);
    if (modes.length < 2) {
        return [];
    }
    const items: ContextMenuItem[] = modes.map((mode) => ({
        label: modeMenuLabel(mode),
        click: () => onSelect(blockDefForMode(blockdef, mode), mode),
    }));
    if (opts?.title) {
        items.unshift({ label: opts.title, enabled: false }, { type: "separator" });
    }
    return items;
}
