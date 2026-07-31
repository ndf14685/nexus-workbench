// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { afterEach, assert, beforeEach, test, vi } from "vitest";
import { JarvisBus } from "./jarvis-bus";
import { MockJarvisRuntime } from "./jarvis-runtime-mock";
import {
    applyTaskTransition,
    deriveActivityState,
    JarvisTaskStore,
    upsertTask,
} from "./jarvis-store";
import { JarvisTask } from "./jarvis-types";

function makeTask(patch: Partial<JarvisTask> = {}): JarvisTask {
    return { id: "t1", state: "queued", title: "test", progress: 0, startedAt: 1, ...patch };
}

test("bus delivers typed events and unsubscribes cleanly", () => {
    const bus = new JarvisBus();
    const seen: string[] = [];
    const off = bus.on("jarvis.taskCreated", (t) => seen.push(t.id));
    bus.emit("jarvis.taskCreated", makeTask());
    off();
    bus.emit("jarvis.taskCreated", makeTask({ id: "t2" }));
    assert.deepEqual(seen, ["t1"]);
});

test("bus survives a throwing handler", () => {
    const bus = new JarvisBus();
    const seen: string[] = [];
    bus.on("jarvis.error", () => {
        throw new Error("boom");
    });
    bus.on("jarvis.error", (e) => seen.push(e.message));
    bus.emit("jarvis.error", { message: "x" });
    assert.deepEqual(seen, ["x"]);
});

test("upsertTask replaces without mutating", () => {
    const tasks = [makeTask()];
    const next = upsertTask(tasks, makeTask({ progress: 50 }));
    assert.equal(tasks[0].progress, 0);
    assert.equal(next[0].progress, 50);
    assert.equal(upsertTask(tasks, makeTask({ id: "t2" })).length, 2);
});

test("applyTaskTransition blocks state changes on terminal tasks", () => {
    const tasks = [makeTask({ state: "completed", endedAt: 2 })];
    const { task } = applyTaskTransition(tasks, "t1", { state: "running" });
    assert.equal(task, null);
    const progressOnly = applyTaskTransition(tasks, "t1", { resultSeen: true });
    assert.notEqual(progressOnly.task, null);
});

test("applyTaskTransition stamps endedAt on terminal states", () => {
    const { task } = applyTaskTransition([makeTask({ state: "running" })], "t1", { state: "cancelled" });
    assert.equal(task.state, "cancelled");
    assert.isNumber(task.endedAt);
});

test("deriveActivityState prioritizes interaction, then approval, then work", () => {
    const running = makeTask({ state: "running" });
    const approval = makeTask({ id: "t2", state: "waiting-approval" });
    assert.equal(deriveActivityState([running], "listening"), "listening");
    assert.equal(deriveActivityState([running, approval], null), "waiting-approval");
    assert.equal(deriveActivityState([running], null), "working");
    assert.equal(deriveActivityState([], null), "idle");
    assert.equal(
        deriveActivityState([makeTask({ state: "completed", result: "ok" })], null),
        "success"
    );
});

test("store emits lifecycle events through the bus", () => {
    const bus = new JarvisBus();
    const store = new JarvisTaskStore(bus);
    const events: string[] = [];
    bus.on("jarvis.taskCreated", () => events.push("created"));
    bus.on("jarvis.taskUpdated", () => events.push("updated"));
    bus.on("jarvis.taskCompleted", () => events.push("completed"));
    bus.on("jarvis.resultReady", () => events.push("result"));
    store.createTask(makeTask());
    store.updateTask("t1", { state: "running" });
    store.updateTask("t1", { state: "completed", result: "done" });
    assert.deepEqual(events, ["created", "updated", "updated", "completed", "result"]);
});

// --- mock runtime lifecycle (fake timers) ---

let bus: JarvisBus;
let store: JarvisTaskStore;
let runtime: MockJarvisRuntime;

beforeEach(() => {
    vi.useFakeTimers();
    bus = new JarvisBus();
    store = new JarvisTaskStore(bus);
    runtime = new MockJarvisRuntime(store, bus);
});

afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
});

test("mock runtime runs a task to completion emitting resultReady", async () => {
    let result: JarvisTask = null;
    bus.on("jarvis.resultReady", (t) => (result = t));
    await runtime.submitPrompt("investigá el error", { host: "rig3060" });
    await vi.advanceTimersByTimeAsync(30_000);
    assert.notEqual(result, null);
    assert.equal(result.state, "completed");
    assert.equal(result.progress, 100);
    assert.include(result.result, "rig3060");
});

test("mock runtime approval flow: HIGH risk pauses, approve resumes, reject cancels", async () => {
    // third scenario is the approval one
    await runtime.submitPrompt("a", {});
    await runtime.submitPrompt("b", {});
    const approvalTaskId = await runtime.submitPrompt("actualizá el servicio", {});
    await vi.advanceTimersByTimeAsync(60_000);
    const task = store.getTasks().find((t) => t.id === approvalTaskId);
    assert.equal(task.state, "waiting-approval");
    assert.equal(task.approval.risk, "HIGH");
    assert.include(task.approval.action, "helm upgrade");

    runtime.approveTask(approvalTaskId, "helm upgrade --dry-run");
    const resumed = store.getTasks().find((t) => t.id === approvalTaskId);
    assert.equal(resumed.state, "running");
    assert.equal(resumed.approval.action, "helm upgrade --dry-run");
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(store.getTasks().find((t) => t.id === approvalTaskId).state, "completed");
});

test("mock runtime reject cancels the task", async () => {
    await runtime.submitPrompt("a", {});
    await runtime.submitPrompt("b", {});
    const id = await runtime.submitPrompt("c", {});
    await vi.advanceTimersByTimeAsync(60_000);
    runtime.rejectTask(id);
    const task = store.getTasks().find((t) => t.id === id);
    assert.equal(task.state, "cancelled");
    assert.isNumber(task.endedAt);
});

test("cancelTask stops an in-flight task", async () => {
    const id = await runtime.submitPrompt("x", {});
    await vi.advanceTimersByTimeAsync(2000);
    runtime.cancelTask(id);
    const stateAfterCancel = store.getTasks().find((t) => t.id === id).state;
    assert.equal(stateAfterCancel, "cancelled");
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(store.getTasks().find((t) => t.id === id).state, "cancelled");
});
