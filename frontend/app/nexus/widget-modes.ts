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

// Devuelve [] cuando no hay ambigüedad que resolver (0 o 1 modo): el llamador
// cae al comportamiento normal de crear el bloque directamente.
export function buildModeMenuItems(
    blockdef: BlockDef,
    onSelect: (blockdef: BlockDef, mode: NexusWidgetMode) => void
): ContextMenuItem[] {
    const modes = parseWidgetModes(blockdef);
    if (modes.length < 2) {
        return [];
    }
    return modes.map((mode) => ({
        label: modeMenuLabel(mode),
        click: () => onSelect(blockDefForMode(blockdef, mode), mode),
    }));
}
