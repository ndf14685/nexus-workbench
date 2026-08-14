// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { CommandContext, CommandDefinition, ShortcutConfig, ShortcutConflict } from "./command-types";

const StorageKey = "nexus-workbench.shortcuts.v1";
const ChordTimeoutMs = 1800;

function normalizePart(part: string): string {
    const bits = part
        .split("+")
        .map((s) => s.trim())
        .filter(Boolean);
    const key = bits.pop() ?? "";
    const mods = new Set(bits.map((s) => s.toLowerCase()));
    const out: string[] = [];
    if (mods.has("ctrl") || mods.has("control")) out.push("Ctrl");
    if (mods.has("shift")) out.push("Shift");
    if (mods.has("alt") || mods.has("option")) out.push("Alt");
    if (mods.has("meta") || mods.has("cmd") || mods.has("command")) out.push("Meta");
    out.push(key.length === 1 ? key.toUpperCase() : key);
    return out.join("+");
}

export function normalizeShortcut(shortcut: string | null | undefined): string | null {
    if (!shortcut || typeof shortcut !== "string") {
        return null;
    }
    return shortcut
        .trim()
        .split(/\s+/)
        .map(normalizePart)
        .join(" ");
}

function eventMatchesPart(event: WaveKeyboardEvent, part: string): boolean {
    const bits = part.split("+");
    const key = bits.pop();
    const mods = new Set(bits);
    if (!!event.control !== mods.has("Ctrl")) return false;
    if (!!event.shift !== mods.has("Shift")) return false;
    if (!!event.alt !== mods.has("Alt")) return false;
    if (!!event.meta !== mods.has("Meta")) return false;
    const eventKey = event.key === " " ? "Space" : event.key?.length === 1 ? event.key.toUpperCase() : event.key;
    return eventKey === key || event.code === key;
}

export function shouldIgnoreShortcutTarget(target: EventTarget | null): boolean {
    const elem = target as HTMLElement | null;
    if (!elem) return false;
    if (elem.closest?.("[data-command-shortcuts='always']")) return false;
    const tag = elem.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || elem.isContentEditable) {
        return true;
    }
    return false;
}

export class ShortcutManager {
    private config: ShortcutConfig = {};
    private chordPrefix: string | null = null;
    private chordTimer: ReturnType<typeof setTimeout> | null = null;
    private changeListeners: Array<() => void> = [];

    constructor(private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage) {
        this.load();
    }

    load() {
        if (!this.storage) return;
        try {
            const parsed = JSON.parse(this.storage.getItem(StorageKey) || "{}");
            this.config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch {
            this.config = {};
        }
    }

    save() {
        this.storage?.setItem(StorageKey, JSON.stringify(this.config, null, 2));
        for (const listener of this.changeListeners) {
            listener();
        }
    }

    onChange(listener: () => void) {
        this.changeListeners.push(listener);
    }

    exportConfig(): ShortcutConfig {
        return { ...this.config };
    }

    importConfig(config: unknown) {
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            this.config = {};
        } else {
            const next: ShortcutConfig = {};
            for (const [id, shortcut] of Object.entries(config as Record<string, unknown>)) {
                if (typeof shortcut === "string" || shortcut === null) {
                    next[id] = normalizeShortcut(shortcut as string | null);
                }
            }
            this.config = next;
        }
        this.save();
    }

    getShortcut(command: CommandDefinition): string | null {
        if (Object.prototype.hasOwnProperty.call(this.config, command.id)) {
            return normalizeShortcut(this.config[command.id]);
        }
        return normalizeShortcut(command.defaultShortcut);
    }

    setShortcut(commandId: string, shortcut: string | null) {
        this.config[commandId] = normalizeShortcut(shortcut);
        this.save();
    }

    resetShortcut(commandId: string) {
        delete this.config[commandId];
        this.save();
    }

    findConflicts(commands: CommandDefinition[]): ShortcutConflict[] {
        const byShortcut = new Map<string, string[]>();
        for (const command of commands) {
            const shortcut = this.getShortcut(command);
            if (!shortcut) continue;
            byShortcut.set(shortcut, [...(byShortcut.get(shortcut) ?? []), command.id]);
        }
        return Array.from(byShortcut.entries())
            .filter(([, ids]) => ids.length > 1)
            .map(([shortcut, commandIds]) => ({ shortcut, commandIds }));
    }

    match(event: WaveKeyboardEvent, commands: CommandDefinition[], context: CommandContext): CommandDefinition | null {
        const candidates = commands.filter((cmd) => cmd.contexts.includes("global") || cmd.contexts.includes(context));
        if (this.chordPrefix) {
            const prefix = this.chordPrefix;
            this.clearChord();
            return (
                candidates.find((cmd) => {
                    const shortcut = this.getShortcut(cmd);
                    const [first, second] = shortcut?.split(/\s+/, 2) ?? [];
                    return first === prefix && second && eventMatchesPart(event, second);
                }) ?? null
            );
        }
        for (const command of candidates) {
            const shortcut = this.getShortcut(command);
            if (!shortcut) continue;
            const [first, second] = shortcut.split(/\s+/, 2);
            if (eventMatchesPart(event, first)) {
                if (second) {
                    this.startChord(first);
                    return null;
                }
                return command;
            }
        }
        return null;
    }

    private startChord(prefix: string) {
        this.clearChord();
        this.chordPrefix = prefix;
        this.chordTimer = setTimeout(() => this.clearChord(), ChordTimeoutMs);
    }

    private clearChord() {
        this.chordPrefix = null;
        if (this.chordTimer) {
            clearTimeout(this.chordTimer);
            this.chordTimer = null;
        }
    }
}

export const shortcutManager = new ShortcutManager();
