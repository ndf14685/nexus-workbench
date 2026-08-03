// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { Modal } from "@/app/modals/modal";
import { modalsModel } from "@/app/store/modalmodel";
import { useMemo, useState } from "react";
import { commandRegistry } from "./command-registry";
import { shortcutManager } from "./shortcut-manager";
import { registerWorkbenchCommands } from "./workbench-commands";

export function CommandPaletteModal() {
    registerWorkbenchCommands();
    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);
    const commands = commandRegistry.list();
    const matches = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return commands;
        return commands.filter((cmd) => `${cmd.title} ${cmd.description} ${cmd.category}`.toLowerCase().includes(needle));
    }, [commands, query]);
    const selected = matches[Math.min(index, Math.max(0, matches.length - 1))];

    const run = async () => {
        if (!selected) return;
        modalsModel.popModal();
        const ok = await commandRegistry.execute(selected.id);
        if (!ok) {
            modalsModel.pushModal("MessageModal", { children: `No se pudo ejecutar: ${selected.title}` });
        }
    };

    return (
        <Modal className="w-[720px] max-w-[92vw]" onClose={() => modalsModel.popModal()} onClickBackdrop={() => modalsModel.popModal()}>
            <div data-command-shortcuts="always" className="bg-modal rounded overflow-hidden border border-border">
                <input
                    autoFocus
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setIndex(0);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") modalsModel.popModal();
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setIndex((i) => Math.min(i + 1, matches.length - 1));
                        }
                        if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setIndex((i) => Math.max(i - 1, 0));
                        }
                        if (e.key === "Enter") {
                            e.preventDefault();
                            void run();
                        }
                    }}
                    placeholder="Buscar comandos"
                    className="w-full bg-panel px-4 py-3 outline-none border-b border-border text-base"
                />
                <div className="max-h-[420px] overflow-auto py-1">
                    {matches.map((cmd, i) => (
                        <button
                            key={cmd.id}
                            onMouseEnter={() => setIndex(i)}
                            onClick={() => void commandRegistry.execute(cmd.id).then(() => modalsModel.popModal())}
                            className={`w-full grid grid-cols-[1fr_auto] gap-3 text-left px-4 py-2 ${i === index ? "bg-accentbg" : "hover:bg-hover"}`}
                        >
                            <span className="min-w-0">
                                <span className="block text-sm text-primary truncate">{cmd.title}</span>
                                <span className="block text-xs text-muted truncate">{cmd.category} · {cmd.description}</span>
                            </span>
                            <span className="text-xs text-muted font-mono self-center">{shortcutManager.getShortcut(cmd) ?? ""}</span>
                        </button>
                    ))}
                    {matches.length === 0 && <div className="px-4 py-6 text-sm text-muted">Sin resultados.</div>}
                </div>
            </div>
        </Modal>
    );
}

CommandPaletteModal.displayName = "CommandPaletteModal";
