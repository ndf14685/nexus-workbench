// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { CommandDefinition, CommandMetadata } from "./command-types";

export class CommandRegistry {
    private commands = new Map<string, CommandDefinition>();

    register(command: CommandDefinition) {
        if (this.commands.has(command.id)) {
            throw new Error(`Command already registered: ${command.id}`);
        }
        this.commands.set(command.id, command);
    }

    get(id: string): CommandDefinition | null {
        return this.commands.get(id) ?? null;
    }

    list(): CommandDefinition[] {
        return Array.from(this.commands.values()).sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
    }

    metadata(): CommandMetadata[] {
        return this.list().map(({ handler: _handler, ...meta }) => meta);
    }

    async execute(id: string): Promise<boolean> {
        const command = this.get(id);
        if (!command) {
            return false;
        }
        const result = await command.handler();
        return result !== false;
    }
}

export const commandRegistry = new CommandRegistry();
