// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { JarvisBus } from "./jarvis-bus";
import { JarvisActivityState, JarvisConnectionState, JarvisTask, JarvisTaskState } from "./jarvis-types";

const TerminalStates: JarvisTaskState[] = ["completed", "cancelled", "error"];

export function isTerminalTaskState(state: JarvisTaskState): boolean {
    return TerminalStates.includes(state);
}

export function activeTasks(tasks: JarvisTask[]): JarvisTask[] {
    return tasks.filter((t) => !isTerminalTaskState(t.state));
}

export function unseenResults(tasks: JarvisTask[]): JarvisTask[] {
    return tasks.filter((t) => t.state === "completed" && t.result != null && !t.resultSeen);
}

// The overall ring state is derived from tasks unless an explicit interaction
// state (listening/speaking/thinking) is in effect.
export function deriveActivityState(tasks: JarvisTask[], interaction: JarvisActivityState | null): JarvisActivityState {
    if (interaction != null) {
        return interaction;
    }
    if (tasks.some((t) => t.state === "waiting-approval")) {
        return "waiting-approval";
    }
    if (tasks.some((t) => t.state === "running" || t.state === "queued")) {
        return "working";
    }
    if (tasks.some((t) => t.state === "error" && t.endedAt != null && Date.now() - t.endedAt < 5000)) {
        return "error";
    }
    if (unseenResults(tasks).length > 0) {
        return "success";
    }
    return "idle";
}

// Surface honesty (ADR-0007, deuda de ADR-0005): what the block must admit
// about itself. "preview" = mock runtime, always badged; "disconnected" =
// real brain configured but unreachable; "live" = showing the brain's truth.
export type JarvisSurfaceMode = "live" | "preview" | "disconnected";

export function deriveSurfaceMode(connection: JarvisConnectionState): JarvisSurfaceMode {
    if (connection === "mock") {
        return "preview";
    }
    if (connection === "disconnected") {
        return "disconnected";
    }
    return "live";
}

// Pure task-list reducer used by the store (and unit tests): returns a new
// array, never mutates.
export function upsertTask(tasks: JarvisTask[], task: JarvisTask): JarvisTask[] {
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx < 0) {
        return [...tasks, task];
    }
    const next = tasks.slice();
    next[idx] = task;
    return next;
}

export function applyTaskTransition(
    tasks: JarvisTask[],
    taskId: string,
    patch: Partial<JarvisTask>
): { tasks: JarvisTask[]; task: JarvisTask | null } {
    const current = tasks.find((t) => t.id === taskId);
    if (current == null || (isTerminalTaskState(current.state) && patch.state != null)) {
        return { tasks, task: null };
    }
    const updated: JarvisTask = { ...current, ...patch };
    if (patch.state != null && isTerminalTaskState(patch.state) && updated.endedAt == null) {
        updated.endedAt = Date.now();
    }
    return { tasks: upsertTask(tasks, updated), task: updated };
}

// TaskStore: owns the task list and emits bus events on every change. It is
// the single source of truth the UI reads; runtimes write through it.
export class JarvisTaskStore {
    private tasks: JarvisTask[] = [];
    private listeners: Set<() => void> = new Set();

    constructor(private bus: JarvisBus) {}

    getTasks(): JarvisTask[] {
        return this.tasks;
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private notify() {
        for (const fn of this.listeners) {
            fn();
        }
    }

    createTask(task: JarvisTask): void {
        this.tasks = upsertTask(this.tasks, task);
        this.bus.emit("jarvis.taskCreated", task);
        this.notify();
    }

    updateTask(taskId: string, patch: Partial<JarvisTask>): JarvisTask | null {
        const { tasks, task } = applyTaskTransition(this.tasks, taskId, patch);
        if (task == null) {
            return null;
        }
        this.tasks = tasks;
        this.bus.emit("jarvis.taskUpdated", task);
        if (task.state === "completed") {
            this.bus.emit("jarvis.taskCompleted", task);
            if (task.result != null) {
                this.bus.emit("jarvis.resultReady", task);
            }
        } else if (task.state === "cancelled") {
            this.bus.emit("jarvis.taskCancelled", task);
        } else if (task.state === "error") {
            this.bus.emit("jarvis.error", { message: task.error ?? "unknown", taskId: task.id });
        }
        this.notify();
        return task;
    }

    markResultSeen(taskId: string): void {
        const current = this.tasks.find((t) => t.id === taskId);
        if (current == null) {
            return;
        }
        this.tasks = upsertTask(this.tasks, { ...current, resultSeen: true });
        this.notify();
    }
}
