// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Cockpit de atención (TODAY). El Workbench no decide qué es importante: lo
// pregunta. Toda la prioridad vive en el Attention Broker de jarvisd
// (/operator/today), la misma fuente que consumen Jarvis Desktop y el móvil.
//
// Regla UX de esta vista: disminuir estímulos, no agregarlos. El detalle
// existe pero hay que abrirlo a propósito.

import {
    dismissWorkItem,
    fetchToday,
    resolveWorkItem,
    setOperatorState,
    type NeedsYouEntry,
    type TodayView,
} from "@/app/nexus/jarvis/brain-client";
import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import * as React from "react";
import {
    actionText,
    batchLine,
    calmLines,
    counters,
    decisionSummary,
    dueLabel,
    EmptyToday,
    hiddenNeedsYouCount,
    isCalmMode,
    OperatorStates,
    showDecisionSection,
    StateChipClasses,
    StateHints,
    StateLabels,
    visibleNeedsYou,
} from "./operator-model";

const RefreshMs = 5000;
const GhostButton =
    "cursor-pointer rounded border border-border bg-transparent px-2.5 py-1 text-xs text-secondary hover:bg-hover transition-colors";

export class OperatorViewModel implements ViewModel {
    viewType: string;
    blockId: string;

    viewIcon = jotai.atom<string>("compass");
    viewName = jotai.atom<string>("Hoy");
    noPadding = jotai.atom<boolean>(true);

    todayAtom: jotai.PrimitiveAtom<TodayView>;
    errorAtom: jotai.PrimitiveAtom<string>;
    loadingAtom: jotai.PrimitiveAtom<boolean>;
    detailsAtom: jotai.PrimitiveAtom<boolean>;
    decisionsAtom: jotai.PrimitiveAtom<boolean>;

    disposed = false;
    timer: ReturnType<typeof setInterval> | null = null;

    constructor({ blockId }: ViewModelInitType) {
        this.viewType = "operator";
        this.blockId = blockId;
        this.todayAtom = jotai.atom<TodayView>(EmptyToday) as jotai.PrimitiveAtom<TodayView>;
        this.errorAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;
        this.loadingAtom = jotai.atom<boolean>(true);
        this.detailsAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        // Colapsado por default: el backlog de decisiones no puede competir
        // visualmente con lo que si necesita al operador ahora.
        this.decisionsAtom = jotai.atom<boolean>(false) as jotai.PrimitiveAtom<boolean>;
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), RefreshMs);
    }

    async refresh() {
        if (this.disposed) {
            return;
        }
        try {
            const view = await fetchToday();
            globalStore.set(this.todayAtom, view);
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            globalStore.set(this.errorAtom, `Cerebro no conectado: ${e}`);
        } finally {
            globalStore.set(this.loadingAtom, false);
        }
    }

    async changeState(state: string) {
        try {
            await setOperatorState(state);
        } catch (e) {
            globalStore.set(this.errorAtom, `No se pudo cambiar el estado: ${e}`);
        }
        await this.refresh();
    }

    async resolve(workItemId: string) {
        try {
            await resolveWorkItem(workItemId);
        } catch (e) {
            globalStore.set(this.errorAtom, `No se pudo cerrar: ${e}`);
        }
        await this.refresh();
    }

    async dismiss(workItemId: string) {
        try {
            await dismissWorkItem(workItemId);
        } catch (e) {
            globalStore.set(this.errorAtom, `No se pudo descartar: ${e}`);
        }
        await this.refresh();
    }

    toggleDetails() {
        globalStore.set(this.detailsAtom, !globalStore.get(this.detailsAtom));
    }

    toggleDecisions() {
        globalStore.set(this.decisionsAtom, !globalStore.get(this.decisionsAtom));
    }

    dispose() {
        this.disposed = true;
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    get viewComponent(): ViewComponent {
        return OperatorView;
    }
}

const StateSwitch: React.FC<{ model: OperatorViewModel; current: string }> = ({ model, current }) => {
    return (
        <div className="flex items-center gap-1.5">
            {OperatorStates.map((state) => (
                <button
                    key={state}
                    title={StateHints[state]}
                    onClick={() => void model.changeState(state)}
                    className={
                        state === current
                            ? `cursor-pointer rounded px-2.5 py-1 text-xs font-semibold transition-colors ${StateChipClasses[state]}`
                            : GhostButton
                    }
                >
                    {StateLabels[state]}
                </button>
            ))}
        </div>
    );
};

const DecisionsForLater: React.FC<{ view: TodayView; open: boolean; onToggle: () => void }> = ({
    view,
    open,
    onToggle,
}) => {
    return (
        <div className="mt-4 border-t border-border pt-3">
            <button className={`${GhostButton} w-full text-left`} onClick={onToggle}>
                {open ? "▾" : "▸"} DECISIONS FOR LATER · {decisionSummary(view)}
            </button>
            {open && (
                <div className="mt-2 text-xs text-secondary">
                    {view.decision_batches.map((batch) => (
                        <div key={batch.batch}>· {batchLine(batch)}</div>
                    ))}
                    <div className="mt-2 text-xxs text-muted">
                        Nada de esto vence ni frena nada. Se revisa cuando vos quieras.
                    </div>
                </div>
            )}
        </div>
    );
};

const Details: React.FC<{ view: TodayView }> = ({ view }) => {
    return (
        <div className="mt-3 text-xs text-secondary">
            {view.done_for_you_items.length > 0 && (
                <>
                    <div className="mt-2 mb-1 text-success">Resuelto sin vos</div>
                    {view.done_for_you_items.map((i) => (
                        <div key={i.work_item_id}>· {i.summary || i.title}</div>
                    ))}
                </>
            )}
            {view.running_items.length > 0 && (
                <>
                    <div className="mt-3 mb-1">En curso</div>
                    {view.running_items.map((i) => (
                        <div key={i.work_item_id}>· {i.title}</div>
                    ))}
                </>
            )}
            {view.watching_items.length > 0 && (
                <>
                    <div className="mt-3 mb-1">Vigilando</div>
                    {view.watching_items.map((i) => (
                        <div key={i.work_item_id}>· {i.title}</div>
                    ))}
                </>
            )}
        </div>
    );
};

const CalmCard: React.FC<{ model: OperatorViewModel; view: TodayView }> = ({ model, view }) => {
    const details = useAtomValue(model.detailsAtom);
    const lines = calmLines(view);
    return (
        <div className="flex h-full flex-col p-4">
            <div className="mb-4 flex justify-end">
                <StateSwitch model={model} current={view.operator_state} />
            </div>
            <div className="flex flex-1 items-center justify-center">
                <div className="w-full max-w-md rounded border border-border bg-panel p-6 text-center">
                    <div className="mb-4 text-title">{lines[0]}</div>
                    {lines.slice(1).map((line) => (
                        <div key={line} className="text-xs text-secondary">
                            {line}
                        </div>
                    ))}
                    <button className={`${GhostButton} mt-5`} onClick={() => model.toggleDetails()}>
                        {details ? "Ocultar detalles" : "Ver detalles"}
                    </button>
                </div>
            </div>
            {details && (
                <div className="max-h-[45%] overflow-y-auto">
                    <Details view={view} />
                    {showDecisionSection(view, details) && (
                        <div className="mt-3 text-xs text-secondary">
                            {decisionSummary(view)} — nada de eso vence ni frena nada.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const CountersRow: React.FC<{ view: TodayView }> = ({ view }) => {
    return (
        <div className="mb-4 flex gap-6">
            {counters(view).map((c) => {
                const tone =
                    c.value === 0
                        ? "text-muted"
                        : c.tone === "attention"
                          ? "text-warning"
                          : c.tone === "good"
                            ? "text-success"
                            : "text-primary";
                return (
                    <div key={c.key}>
                        <div className={`text-2xl font-bold ${tone}`}>{c.value}</div>
                        <div className="text-xxs tracking-widest text-muted">{c.label}</div>
                    </div>
                );
            })}
        </div>
    );
};

const NeedsYouCard: React.FC<{ model: OperatorViewModel; entry: NeedsYouEntry }> = ({ model, entry }) => {
    const due = dueLabel(entry.due_at, Date.now());
    const context = [entry.reason, due, entry.project, entry.approval_required ? "requiere tu aprobación" : ""]
        .filter(Boolean)
        .join(" · ");
    return (
        <div className="mb-2.5 rounded border border-border bg-panel p-3.5">
            <div className="mb-1.5 text-sm font-semibold">{actionText(entry)}</div>
            <div className="mb-2.5 text-xs text-secondary">{context}</div>
            <div className="flex gap-2">
                <button className={GhostButton} onClick={() => void model.resolve(entry.work_item_id)}>
                    Listo
                </button>
                <button className={GhostButton} onClick={() => void model.dismiss(entry.work_item_id)}>
                    No importa
                </button>
            </div>
        </div>
    );
};

const OperatorView: React.FC<ViewComponentProps<OperatorViewModel>> = ({ model }) => {
    const view = useAtomValue(model.todayAtom);
    const error = useAtomValue(model.errorAtom);
    const loading = useAtomValue(model.loadingAtom);
    const details = useAtomValue(model.detailsAtom);
    const decisionsOpen = useAtomValue(model.decisionsAtom);

    if (loading && error == null && view === EmptyToday) {
        return <div className="p-3.5 text-xs text-secondary">Cargando…</div>;
    }
    if (error == null && isCalmMode(view)) {
        return <CalmCard model={model} view={view} />;
    }

    const visible = visibleNeedsYou(view);
    const hidden = hiddenNeedsYouCount(view);
    return (
        <div className="h-full overflow-y-auto p-3.5">
            <div className="mb-4 flex items-center justify-between">
                <div className="text-xxs tracking-[0.2em] text-muted">HOY</div>
                <StateSwitch model={model} current={view.operator_state} />
            </div>
            {error != null && <div className="mb-2.5 text-xs text-warning">{error}</div>}
            <CountersRow view={view} />
            {visible.length === 0 && error == null && (
                <div className="mb-2.5 rounded border border-border bg-panel p-3.5 text-sm">
                    {view.message || "No hay nada urgente."}
                </div>
            )}
            {visible.map((entry) => (
                <NeedsYouCard key={entry.work_item_id} model={model} entry={entry} />
            ))}
            {hidden > 0 && (
                <div className="mb-2.5 text-xxs text-muted">
                    {hidden} pendiente{hidden === 1 ? "" : "s"} más quedaron agrupados: no requieren decidir ahora.
                </div>
            )}
            <button className={GhostButton} onClick={() => model.toggleDetails()}>
                {details ? "Ocultar detalles" : "Ver detalles"}
            </button>
            {details && <Details view={view} />}
            {showDecisionSection(view, details) && (
                <DecisionsForLater
                    view={view}
                    open={decisionsOpen}
                    onToggle={() => model.toggleDecisions()}
                />
            )}
        </div>
    );
};
