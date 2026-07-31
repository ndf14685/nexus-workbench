// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Mock runtime + mock voice provider. These are placeholders that exercise the
// full task/event/approval machinery with realistic timing; OpenClaw/Jarvis
// Runtime will replace MockJarvisRuntime behind the JarvisRuntime interface
// (ADR-0005) without touching UI, store or bus.

import { JarvisBus } from "./jarvis-bus";
import { JarvisTaskStore } from "./jarvis-store";
import { JarvisRuntime, JarvisTask, VoiceProvider, WorkbenchContext } from "./jarvis-types";

let taskCounter = 0;

function makeTaskId(): string {
    taskCounter++;
    return `jt-${Date.now().toString(36)}-${taskCounter}`;
}

type MockScenario = {
    title: (prompt: string, ctx: WorkbenchContext) => string;
    needsApproval?: boolean;
    result: (prompt: string, ctx: WorkbenchContext) => string;
};

const Scenarios: MockScenario[] = [
    {
        title: () => "Investigando el error de deployment",
        result: (_p, ctx) =>
            `Causa probable encontrada: el pod quedó en CrashLoopBackOff por un límite de memoria.\n` +
            `Contexto usado: host=${ctx.host ?? "?"} env=${ctx.environment ?? "?"}.\n` +
            `Recomendación: subir resources.limits.memory a 512Mi y redeplegar.`,
    },
    {
        title: () => "Analizando logs del servicio",
        result: () =>
            "3 errores repetidos en la última hora, todos ECONNREFUSED contra :5432.\nLa DB rechaza conexiones desde las 14:32 — revisar pool o reinicio de postgres.",
    },
    {
        title: () => "Preparando actualización del servicio",
        needsApproval: true,
        result: () => "helm upgrade simulado OK (mock): release actualizada a la revisión 7.",
    },
];

export class MockJarvisRuntime implements JarvisRuntime {
    private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
    private scenarioIdx = 0;

    constructor(
        private store: JarvisTaskStore,
        private bus: JarvisBus
    ) {}

    async submitPrompt(prompt: string, context: WorkbenchContext): Promise<string> {
        const scenario = Scenarios[this.scenarioIdx % Scenarios.length];
        this.scenarioIdx++;
        const task: JarvisTask = {
            id: makeTaskId(),
            state: "queued",
            title: scenario.title(prompt, context),
            progress: 0,
            startedAt: Date.now(),
        };
        this.store.createTask(task);
        setTimeout(() => this.run(task.id, scenario, prompt, context), 400);
        return task.id;
    }

    private run(taskId: string, scenario: MockScenario, prompt: string, ctx: WorkbenchContext) {
        this.store.updateTask(taskId, { state: "running", progress: 5 });
        const timer = setInterval(() => {
            const task = this.store.getTasks().find((t) => t.id === taskId);
            if (task == null || task.state !== "running") {
                return;
            }
            const nextProgress = Math.min(task.progress + 6 + Math.floor(Math.random() * 9), 100);
            if (scenario.needsApproval && nextProgress >= 55 && task.approval == null) {
                this.store.updateTask(taskId, {
                    state: "waiting-approval",
                    progress: nextProgress,
                    approval: {
                        action: "helm upgrade media-center ./chart --set image.tag=1.4.2 -n prod",
                        risk: "HIGH",
                        reason: "Modifica un release en un ambiente productivo",
                    },
                });
                return;
            }
            if (nextProgress >= 100) {
                this.finish(taskId, scenario.result(prompt, ctx));
                return;
            }
            this.store.updateTask(taskId, { progress: nextProgress });
        }, 700);
        this.timers.set(taskId, timer);
    }

    private finish(taskId: string, result: string) {
        this.clearTimer(taskId);
        this.store.updateTask(taskId, { state: "completed", progress: 100, result });
    }

    private clearTimer(taskId: string) {
        const timer = this.timers.get(taskId);
        if (timer != null) {
            clearInterval(timer);
            this.timers.delete(taskId);
        }
    }

    cancelTask(taskId: string): void {
        this.clearTimer(taskId);
        this.store.updateTask(taskId, { state: "cancelled" });
    }

    approveTask(taskId: string, editedAction?: string): void {
        const task = this.store.getTasks().find((t) => t.id === taskId);
        if (task?.state !== "waiting-approval") {
            return;
        }
        const approval = editedAction != null ? { ...task.approval, action: editedAction } : task.approval;
        this.store.updateTask(taskId, { state: "running", approval });
    }

    rejectTask(taskId: string): void {
        this.clearTimer(taskId);
        this.store.updateTask(taskId, { state: "cancelled", error: "Acción rechazada por el operador" });
    }

    dispose(): void {
        for (const taskId of [...this.timers.keys()]) {
            this.clearTimer(taskId);
        }
    }
}

const MockPhrases = [
    "investigá el error del último deployment",
    "analizá los logs del servicio de media",
    "actualizá el servicio media-center a la 1.4.2",
];

export class MockVoiceProvider implements VoiceProvider {
    private listening = false;
    private phraseIdx = 0;

    async startListening(): Promise<void> {
        this.listening = true;
    }

    async stopListening(): Promise<void> {
        this.listening = false;
    }

    async transcribe(): Promise<string> {
        const phrase = MockPhrases[this.phraseIdx % MockPhrases.length];
        this.phraseIdx++;
        return phrase;
    }

    isListening(): boolean {
        return this.listening;
    }
}
