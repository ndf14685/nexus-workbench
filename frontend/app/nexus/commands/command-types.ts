// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

export type CommandContext = "global" | "terminal" | "browser" | "editor" | "modal" | "settings";

export type CommandDefinition = {
    id: string;
    title: string;
    description: string;
    category: string;
    defaultShortcut?: string;
    contexts: CommandContext[];
    editable: boolean;
    handler: () => boolean | void | Promise<boolean | void>;
};

export type CommandMetadata = Omit<CommandDefinition, "handler">;

export type ShortcutConfig = Record<string, string | null>;

export type ShortcutConflict = {
    shortcut: string;
    commandIds: string[];
};
