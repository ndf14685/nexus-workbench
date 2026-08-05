// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString } from "@/util/util";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import * as React from "react";
import {
    auditDecisions,
    auditEnvironments,
    decisionKind,
    filterAuditRecords,
    isSensitive,
    parseAuditLog,
    summarizeAudit,
    type AuditRecord,
} from "./nexus-audit-log";
import type { NexusAuditEnv } from "./nexusauditenv";

const AuditFileName = "nexus-mcp-audit.jsonl";
const RefreshMs = 4000;

const decisionStyles: Record<string, string> = {
    executed: "text-secondary",
    confirmed: "text-warning",
    confirmation_required: "text-warning",
    blocked: "text-error",
    error: "text-error",
    unknown: "text-secondary",
};

export class NexusAuditViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    env: NexusAuditEnv;

    viewIcon = jotai.atom<string>("clipboard-list");
    viewName = jotai.atom<string>("Auditoría MCP");
    noPadding = jotai.atom<boolean>(true);

    recordsAtom: jotai.PrimitiveAtom<AuditRecord[]>;
    errorAtom: jotai.PrimitiveAtom<string>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    textFilterAtom: jotai.PrimitiveAtom<string>;
    envFilterAtom: jotai.PrimitiveAtom<string>;
    decisionFilterAtom: jotai.PrimitiveAtom<string>;
    onlySensitiveAtom: jotai.PrimitiveAtom<boolean>;
    pausedAtom: jotai.PrimitiveAtom<boolean>;
    selectedAtom: jotai.PrimitiveAtom<AuditRecord>;

    visibleAtom: jotai.Atom<AuditRecord[]>;
    summaryAtom: jotai.Atom<ReturnType<typeof summarizeAudit>>;

    disposed = false;
    timer: ReturnType<typeof setInterval> | null = null;

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.viewType = "nexusaudit";
        this.blockId = blockId;
        this.env = waveEnv;

        this.recordsAtom = jotai.atom<AuditRecord[]>([]) as jotai.PrimitiveAtom<AuditRecord[]>;
        this.errorAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
        this.loadingAtom = jotai.atom<boolean>(true);
        this.textFilterAtom = jotai.atom<string>("");
        this.envFilterAtom = jotai.atom<string>("");
        this.decisionFilterAtom = jotai.atom<string>("");
        this.onlySensitiveAtom = jotai.atom<boolean>(false);
        this.pausedAtom = jotai.atom<boolean>(false);
        this.selectedAtom = jotai.atom<AuditRecord>(null) as jotai.PrimitiveAtom<AuditRecord>;

        this.visibleAtom = jotai.atom((get) =>
            filterAuditRecords(get(this.recordsAtom), {
                text: get(this.textFilterAtom),
                env: get(this.envFilterAtom),
                decision: get(this.decisionFilterAtom),
                onlySensitive: get(this.onlySensitiveAtom),
            })
        );
        this.summaryAtom = jotai.atom((get) => summarizeAudit(get(this.recordsAtom)));

        void this.refresh();
        this.timer = setInterval(() => {
            if (!globalStore.get(this.pausedAtom)) {
                void this.refresh();
            }
        }, RefreshMs);
    }

    get viewComponent(): ViewComponent {
        return NexusAuditView;
    }

    auditPath(): string {
        const dataDir = this.env.electron.getDataDir();
        return `${dataDir}/${AuditFileName}`;
    }

    async refresh() {
        if (this.disposed) {
            return;
        }
        try {
            const file = await this.env.rpc.FileReadCommand(TabRpcClient, { info: { path: this.auditPath() } });
            const content = file?.data64 ? base64ToString(file.data64) : "";
            globalStore.set(this.recordsAtom, parseAuditLog(content).reverse());
            globalStore.set(this.errorAtom, null);
        } catch (err) {
            // el archivo sólo existe una vez que el MCP registró la primera acción
            globalStore.set(this.errorAtom, err?.message ?? String(err));
        } finally {
            globalStore.set(this.loadingAtom, false);
        }
    }

    getSettingsMenuItems(): ContextMenuItem[] {
        return [
            { label: "Refrescar ahora", click: () => void this.refresh() },
            {
                label: globalStore.get(this.pausedAtom) ? "Reanudar auto-refresco" : "Pausar auto-refresco",
                click: () => globalStore.set(this.pausedAtom, !globalStore.get(this.pausedAtom)),
            },
            { type: "separator" },
            { label: "Copiar ruta del audit", click: () => void navigator.clipboard.writeText(this.auditPath()) },
        ];
    }

    dispose() {
        this.disposed = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

const SummaryBar: React.FC<{ model: NexusAuditViewModel }> = ({ model }) => {
    const summary = useAtomValue(model.summaryAtom);
    const onlySensitive = useAtomValue(model.onlySensitiveAtom);
    return (
        <div className="flex items-center gap-4 px-3 py-2 text-xs border-b border-border">
            <span>
                <span className="text-secondary">acciones</span> {summary.total}
            </span>
            <span className={summary.awaitingConfirmation > 0 ? "text-warning" : ""}>
                <span className="text-secondary">esperando confirmación</span> {summary.awaitingConfirmation}
            </span>
            <span className={summary.errors > 0 ? "text-error" : ""}>
                <span className="text-secondary">errores</span> {summary.errors}
            </span>
            <span>
                <span className="text-secondary">credenciales ocultadas</span> {summary.redacted}
            </span>
            <button
                className="ml-auto cursor-pointer rounded px-2 py-0.5 bg-accent/80 text-primary hover:bg-accent transition-colors"
                onClick={() => globalStore.set(model.onlySensitiveAtom, !onlySensitive)}
            >
                {onlySensitive ? "ver todo" : `solo sensibles (${summary.sensitive})`}
            </button>
        </div>
    );
};

const FilterBar: React.FC<{ model: NexusAuditViewModel }> = ({ model }) => {
    const records = useAtomValue(model.recordsAtom);
    const text = useAtomValue(model.textFilterAtom);
    const envFilter = useAtomValue(model.envFilterAtom);
    const decisionFilter = useAtomValue(model.decisionFilterAtom);
    return (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <input
                className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-sm"
                placeholder="Buscar comando, ambiente, herramienta…"
                value={text}
                onChange={(e) => globalStore.set(model.textFilterAtom, e.target.value)}
            />
            <select
                className="bg-transparent border border-border rounded px-2 py-1 text-sm cursor-pointer"
                value={envFilter}
                onChange={(e) => globalStore.set(model.envFilterAtom, e.target.value)}
            >
                <option value="">todos los ambientes</option>
                {auditEnvironments(records).map((env) => (
                    <option key={env} value={env}>
                        {env}
                    </option>
                ))}
            </select>
            <select
                className="bg-transparent border border-border rounded px-2 py-1 text-sm cursor-pointer"
                value={decisionFilter}
                onChange={(e) => globalStore.set(model.decisionFilterAtom, e.target.value)}
            >
                <option value="">todas las decisiones</option>
                {auditDecisions(records).map((decision) => (
                    <option key={decision} value={decision}>
                        {decision}
                    </option>
                ))}
            </select>
        </div>
    );
};

const AuditRow: React.FC<{ model: NexusAuditViewModel; rec: AuditRecord }> = ({ model, rec }) => {
    const kind = decisionKind(rec);
    if (rec.malformed) {
        return (
            <tr className="border-b border-border/40">
                <td className="px-3 py-1 text-error" colSpan={5}>
                    línea {rec.line} corrupta: {rec.raw}
                </td>
            </tr>
        );
    }
    return (
        <tr className={`border-b border-border/40 ${isSensitive(rec) ? "bg-warning/5" : ""}`}>
            <td className="px-3 py-1 whitespace-nowrap text-secondary">{rec.ts}</td>
            <td className="px-3 py-1 whitespace-nowrap">{rec.tool}</td>
            <td className="px-3 py-1 whitespace-nowrap">{rec.env}</td>
            <td className={`px-3 py-1 whitespace-nowrap ${decisionStyles[kind] ?? ""}`}>
                {rec.decision}
                {rec.redacted ? <span className="ml-1 text-secondary">({rec.redacted} oculto/s)</span> : null}
            </td>
            <td className="px-3 py-1 font-mono">
                <span className="break-all">{rec.detail}</span>
                {rec.detail ? (
                    <button
                        className="ml-2 cursor-pointer text-secondary hover:text-primary"
                        title="Copiar"
                        onClick={() => void navigator.clipboard.writeText(rec.detail)}
                    >
                        copiar
                    </button>
                ) : null}
            </td>
        </tr>
    );
};

export const NexusAuditView: React.FC<ViewComponentProps<NexusAuditViewModel>> = React.memo(({ model }) => {
    const visible = useAtomValue(model.visibleAtom);
    const loading = useAtomValue(model.loadingAtom);
    const error = useAtomValue(model.errorAtom);

    if (loading) {
        return <div className="p-4 text-secondary">Leyendo la auditoría…</div>;
    }
    if (error) {
        return (
            <div className="p-4">
                <div className="text-secondary">Todavía no hay auditoría que mostrar.</div>
                <div className="mt-2 text-xs text-secondary">
                    El archivo aparece cuando el servidor MCP registra su primera acción: {model.auditPath()}
                </div>
            </div>
        );
    }
    return (
        <div className="h-full w-full flex flex-col overflow-hidden">
            <SummaryBar model={model} />
            <FilterBar model={model} />
            <div className="flex-1 overflow-auto">
                <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-panel">
                        <tr className="text-left text-secondary">
                            <th className="px-3 py-1 font-normal">cuándo</th>
                            <th className="px-3 py-1 font-normal">herramienta</th>
                            <th className="px-3 py-1 font-normal">ambiente</th>
                            <th className="px-3 py-1 font-normal">decisión</th>
                            <th className="px-3 py-1 font-normal">detalle</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((rec) => (
                            <AuditRow key={rec.line} model={model} rec={rec} />
                        ))}
                    </tbody>
                </table>
                {visible.length === 0 ? <div className="p-4 text-secondary">Ningún registro coincide con el filtro.</div> : null}
            </div>
        </div>
    );
});

NexusAuditView.displayName = "NexusAuditView";
