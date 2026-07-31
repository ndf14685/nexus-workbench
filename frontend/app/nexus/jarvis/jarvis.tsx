// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { cn } from "@/util/util";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState } from "react";
import { JarvisCore } from "./jarvis-core";
import { JarvisRing } from "./jarvis-ring";
import { activeTasks, isTerminalTaskState, unseenResults } from "./jarvis-store";
import { JarvisActivityState, JarvisTask } from "./jarvis-types";

const StateLabels: Record<JarvisActivityState, string> = {
    idle: "En espera",
    listening: "Escuchando…",
    thinking: "Pensando…",
    working: "Trabajando…",
    "waiting-approval": "Esperando aprobación",
    speaking: "Hablando…",
    success: "Resultado disponible",
    error: "Error",
};

const RiskColors: Record<string, string> = {
    LOW: "#3fb950",
    MEDIUM: "#d29922",
    HIGH: "#f85149",
};

type SizeMode = "compact" | "medium" | "large";

function sizeModeFor(width: number, height: number): SizeMode {
    if (width < 240 || height < 200) {
        return "compact";
    }
    if (width < 460) {
        return "medium";
    }
    return "large";
}

const PushToTalkButton = memo(({ listening }: { listening: boolean }) => {
    const core = JarvisCore.getInstance();
    return (
        <button
            className={cn(
                "flex items-center gap-2 px-3 py-1 rounded-md text-sm cursor-pointer transition-colors",
                listening
                    ? "bg-[#7ee0e6]/20 text-[#7ee0e6] border border-[#7ee0e6]/50"
                    : "bg-accent/80 text-primary hover:bg-accent"
            )}
            onClick={() => core.pushToTalk()}
        >
            <i className={cn("fa fa-solid", listening ? "fa-microphone-lines fa-beat" : "fa-microphone")} />
            {listening ? "Escuchando… (soltar)" : "Hablar"}
        </button>
    );
});
PushToTalkButton.displayName = "PushToTalkButton";

const TaskCard = memo(({ task }: { task: JarvisTask }) => {
    const core = JarvisCore.getInstance();
    const [showResult, setShowResult] = useState(false);
    const [editing, setEditing] = useState(false);
    const [editedAction, setEditedAction] = useState("");

    if (task.state === "waiting-approval" && task.approval != null) {
        return (
            <div className="flex flex-col gap-2 p-2 rounded-md border border-[#d29922]/50 bg-[#d29922]/10">
                <div className="flex items-center gap-2 text-sm text-primary">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#d29922" }} />
                    <span className="flex-1 truncate">{task.title}</span>
                    <span
                        className="text-xxs font-bold px-1.5 py-0.5 rounded"
                        style={{ color: RiskColors[task.approval.risk], border: `1px solid ${RiskColors[task.approval.risk]}` }}
                    >
                        {task.approval.risk}
                    </span>
                </div>
                <div className="text-xs text-secondary">Jarvis solicita ejecutar:</div>
                {editing ? (
                    <textarea
                        className="text-xs font-mono bg-black/30 rounded p-1.5 text-primary border border-border w-full"
                        rows={2}
                        value={editedAction}
                        onChange={(e) => setEditedAction(e.target.value)}
                    />
                ) : (
                    <code className="text-xs font-mono bg-black/30 rounded p-1.5 text-primary overflow-x-auto whitespace-pre">
                        {task.approval.action}
                    </code>
                )}
                {task.approval.reason ? <div className="text-xxs text-muted">{task.approval.reason}</div> : null}
                <div className="flex gap-2">
                    <button
                        className="px-2 py-0.5 rounded text-xs bg-accent/80 text-primary hover:bg-accent transition-colors cursor-pointer"
                        onClick={() => core.runtime.approveTask(task.id, editing ? editedAction : undefined)}
                    >
                        Approve
                    </button>
                    <button
                        className="px-2 py-0.5 rounded text-xs text-secondary hover:bg-hoverbg hover:text-primary transition-colors cursor-pointer"
                        onClick={() => {
                            setEditedAction(task.approval.action);
                            setEditing(!editing);
                        }}
                    >
                        Edit
                    </button>
                    <button
                        className="px-2 py-0.5 rounded text-xs text-error hover:bg-hoverbg transition-colors cursor-pointer"
                        onClick={() => core.runtime.rejectTask(task.id)}
                    >
                        Reject
                    </button>
                </div>
            </div>
        );
    }

    if (!isTerminalTaskState(task.state)) {
        return (
            <div className="flex flex-col gap-1 p-2 rounded-md border border-border bg-hoverbg/40">
                <div className="flex items-center gap-2 text-sm text-primary">
                    <span className="w-2 h-2 rounded-full shrink-0 animate-pulse" style={{ backgroundColor: "#58a6ff" }} />
                    <span className="flex-1 truncate">{task.title}</span>
                    <span className="text-xs text-secondary">{task.progress}%</span>
                    <button
                        className="text-xs text-muted hover:text-error cursor-pointer"
                        title="Cancelar tarea"
                        onClick={() => core.runtime.cancelTask(task.id)}
                    >
                        <i className="fa fa-solid fa-xmark" />
                    </button>
                </div>
                <div className="h-1 rounded bg-black/30 overflow-hidden">
                    <div
                        className="h-full rounded bg-[#58a6ff] transition-all duration-500"
                        style={{ width: `${task.progress}%` }}
                    />
                </div>
            </div>
        );
    }

    if (task.state === "completed" && task.result != null && !task.resultSeen) {
        return (
            <div className="flex flex-col gap-1.5 p-2 rounded-md border border-[#3fb950]/40 bg-[#3fb950]/10">
                <div className="flex items-center gap-2 text-sm text-primary">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: "#3fb950" }} />
                    <span className="flex-1 truncate">{task.title}</span>
                    <span className="text-xs text-[#3fb950]">Resultado disponible</span>
                </div>
                {showResult ? (
                    <div className="text-xs text-secondary whitespace-pre-wrap bg-black/20 rounded p-1.5">{task.result}</div>
                ) : null}
                <div className="flex gap-2">
                    <button
                        className="px-2 py-0.5 rounded text-xs bg-accent/80 text-primary hover:bg-accent transition-colors cursor-pointer"
                        onClick={() => {
                            if (showResult) {
                                core.store.markResultSeen(task.id);
                            }
                            setShowResult(!showResult);
                        }}
                    >
                        {showResult ? "OK" : "Ver"}
                    </button>
                    <button
                        className="px-2 py-0.5 rounded text-xs text-secondary hover:bg-hoverbg hover:text-primary transition-colors cursor-pointer"
                        onClick={() => core.store.markResultSeen(task.id)}
                    >
                        Descartar
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted">
            <i
                className={cn(
                    "fa fa-solid",
                    task.state === "completed" ? "fa-check text-[#3fb950]" : task.state === "error" ? "fa-triangle-exclamation text-error" : "fa-ban"
                )}
            />
            <span className="flex-1 truncate">{task.title}</span>
            {task.error ? <span className="truncate max-w-[40%]">{task.error}</span> : null}
        </div>
    );
});
TaskCard.displayName = "TaskCard";

const JarvisView = memo(({ blockId, contentRef, model }: ViewComponentProps<JarvisViewModel>) => {
    const core = JarvisCore.getInstance();
    const activity = useAtomValue(core.activityAtom);
    const tasks = useAtomValue(core.tasksAtom);
    const transcript = useAtomValue(core.transcriptAtom);
    const ctx = useAtomValue(core.contextAtom);
    const interaction = useAtomValue(core.interactionAtom);
    const [sizeMode, setSizeMode] = useState<SizeMode>("large");
    const [order, setOrder] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (el == null) {
            return;
        }
        const observer = new ResizeObserver(() => {
            setSizeMode(sizeModeFor(el.clientWidth, el.clientHeight));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const active = activeTasks(tasks);
    const pending = unseenResults(tasks);
    const history = tasks.filter((t) => isTerminalTaskState(t.state));
    const listening = interaction === "listening";

    if (sizeMode === "compact") {
        return (
            <div
                ref={containerRef}
                className="flex items-center justify-center w-full h-full cursor-pointer"
                title={`Jarvis — ${StateLabels[activity]}${active.length ? ` (${active.length} tareas)` : ""}`}
                onClick={() => core.pushToTalk()}
            >
                <JarvisRing state={activity} size={90} />
            </div>
        );
    }

    if (sizeMode === "medium") {
        return (
            <div ref={containerRef} className="flex flex-col items-center justify-center gap-2 w-full h-full p-2">
                <JarvisRing state={activity} size={110} />
                <div className="text-sm text-primary">{StateLabels[activity]}</div>
                <div className="text-xs text-secondary">
                    {active.length > 0 ? `${active.length} tarea${active.length > 1 ? "s" : ""} activa${active.length > 1 ? "s" : ""}` : "sin tareas activas"}
                    {pending.length > 0 ? ` · ${pending.length} resultado${pending.length > 1 ? "s" : ""}` : ""}
                </div>
                <PushToTalkButton listening={listening} />
            </div>
        );
    }

    return (
        <div ref={containerRef} className="flex flex-col gap-3 w-full h-full p-3 overflow-y-auto">
            <div className="flex items-center gap-4 shrink-0">
                <JarvisRing state={activity} size={72} />
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                    <div className="text-base text-primary">{StateLabels[activity]}</div>
                    <div className="flex flex-wrap gap-1.5 text-xxs text-muted">
                        {ctx.host ? <span className="px-1.5 py-0.5 rounded bg-hoverbg">{ctx.host}</span> : null}
                        {ctx.environment ? <span className="px-1.5 py-0.5 rounded bg-hoverbg">{ctx.environment}</span> : null}
                        {ctx.workspace ? <span className="px-1.5 py-0.5 rounded bg-hoverbg">{ctx.workspace}</span> : null}
                        {ctx.workingDirectory ? (
                            <span className="px-1.5 py-0.5 rounded bg-hoverbg truncate max-w-[180px]">{ctx.workingDirectory}</span>
                        ) : null}
                    </div>
                    {transcript ? <div className="text-xs text-secondary truncate">«{transcript}»</div> : null}
                </div>
                <PushToTalkButton listening={listening} />
            </div>

            <form
                className="flex gap-2 shrink-0"
                onSubmit={(e) => {
                    e.preventDefault();
                    core.submit(order);
                    setOrder("");
                }}
            >
                <input
                    className="flex-1 bg-hoverbg/50 border border-border rounded-md px-2 py-1 text-sm text-primary placeholder:text-muted outline-none focus:border-accent"
                    placeholder="Orden para Jarvis (ej: investigá este error)"
                    value={order}
                    onChange={(e) => setOrder(e.target.value)}
                />
            </form>

            {active.length > 0 || pending.length > 0 ? (
                <div className="flex flex-col gap-1.5 shrink-0">
                    {active.map((t) => (
                        <TaskCard key={t.id} task={t} />
                    ))}
                    {pending.map((t) => (
                        <TaskCard key={t.id} task={t} />
                    ))}
                </div>
            ) : (
                <div className="text-xs text-muted text-center py-2">Sin tareas activas — Jarvis está en espera.</div>
            )}

            {history.length > 0 ? (
                <div className="flex flex-col gap-0.5 mt-auto shrink-0">
                    <div className="text-xxs text-muted uppercase tracking-wider px-1">Historial</div>
                    {history.slice(-6).reverse().map((t) => (
                        <TaskCard key={t.id} task={t} />
                    ))}
                </div>
            ) : null}
        </div>
    );
});
JarvisView.displayName = "JarvisView";

export class JarvisViewModel implements ViewModel {
    viewType = "jarvis";
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = jotai.atom("circle-notch");
    viewName = jotai.atom("Jarvis");
    noPadding = jotai.atom(true);

    constructor({ blockId, nodeModel }: { blockId: string; nodeModel: BlockNodeModel }) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        JarvisCore.getInstance();
    }

    get viewComponent(): ViewComponent {
        return JarvisView as ViewComponent;
    }

    giveFocus(): boolean {
        return false;
    }
}
