// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { useMemo, useState } from "react";
import { commandRegistry } from "./command-registry";
import { shortcutManager } from "./shortcut-manager";
import { registerWorkbenchCommands } from "./workbench-commands";

export function KeyboardShortcutsSettings(_props: { model: WaveConfigViewModel }) {
    registerWorkbenchCommands();
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("Todos");
    const [version, setVersion] = useState(0);
    const [message, setMessage] = useState<string | null>(null);
    const commands = commandRegistry.list();
    const conflicts = shortcutManager.findConflicts(commands);
    const categories = ["Todos", ...Array.from(new Set(commands.map((cmd) => cmd.category))).sort()];
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return commands.filter((cmd) => {
            if (category !== "Todos" && cmd.category !== category) return false;
            if (!needle) return true;
            return `${cmd.title} ${cmd.description} ${cmd.category}`.toLowerCase().includes(needle);
        });
    }, [commands, query, category, version]);

    const bump = () => setVersion((v) => v + 1);
    const setShortcut = (id: string, value: string) => {
        const existing = commands.find((cmd) => cmd.id !== id && shortcutManager.getShortcut(cmd) === value);
        if (existing && !window.confirm(`El atajo ya está asignado a "${existing.title}". ¿Reemplazar de todos modos?`)) {
            return;
        }
        shortcutManager.setShortcut(id, value || null);
        bump();
    };

    const exportJson = () => {
        setMessage(JSON.stringify(shortcutManager.exportConfig(), null, 2));
    };

    const importJson = () => {
        const raw = window.prompt("Pegá la configuración JSON de atajos");
        if (raw == null) return;
        try {
            shortcutManager.importConfig(JSON.parse(raw));
            setMessage("Configuración importada.");
            bump();
        } catch (e) {
            setMessage(`JSON inválido: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    return (
        <div className="flex flex-col h-full min-h-0 p-4 gap-4 overflow-auto">
            <div>
                <div className="text-lg font-semibold">Atajos de teclado</div>
                <div className="text-sm text-muted mt-1">Personalizá comandos del Workbench. Los cambios se guardan localmente.</div>
            </div>
            <div className="flex gap-2 flex-wrap">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar comando" className="bg-panel border border-border rounded px-3 py-1.5 text-sm min-w-64" />
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="bg-panel border border-border rounded px-3 py-1.5 text-sm">
                    {categories.map((cat) => <option key={cat}>{cat}</option>)}
                </select>
                <button className="border border-border rounded px-3 py-1.5 text-sm hover:bg-hover" onClick={exportJson}>Exportar JSON</button>
                <button className="border border-border rounded px-3 py-1.5 text-sm hover:bg-hover" onClick={importJson}>Importar JSON</button>
            </div>
            {conflicts.length > 0 && <div className="text-warning text-sm">Conflictos: {conflicts.map((c) => c.shortcut).join(", ")}</div>}
            {message && <pre className="text-xs bg-panel border border-border rounded p-3 whitespace-pre-wrap">{message}</pre>}
            <div className="grid grid-cols-[1fr_180px_220px] gap-2 text-xs text-muted uppercase border-b border-border pb-2">
                <div>Comando</div>
                <div>Categoría</div>
                <div>Atajo</div>
            </div>
            {filtered.map((cmd) => (
                <div key={cmd.id} className="grid grid-cols-[1fr_180px_220px] gap-2 items-center border-b border-border/60 py-2 text-sm">
                    <div className="min-w-0">
                        <div className="truncate">{cmd.title}</div>
                        <div className="text-xs text-muted truncate">{cmd.description}</div>
                        <div className="text-xs text-muted font-mono truncate">{cmd.id}</div>
                    </div>
                    <div>{cmd.category}</div>
                    <div className="flex gap-2">
                        <input
                            disabled={!cmd.editable}
                            value={shortcutManager.getShortcut(cmd) ?? ""}
                            onChange={(e) => setShortcut(cmd.id, e.target.value)}
                            className="bg-panel border border-border rounded px-2 py-1 text-xs font-mono w-32"
                        />
                        <button className="border border-border rounded px-2 py-1 hover:bg-hover" onClick={() => { shortcutManager.resetShortcut(cmd.id); bump(); }}>Reset</button>
                    </div>
                </div>
            ))}
        </div>
    );
}
