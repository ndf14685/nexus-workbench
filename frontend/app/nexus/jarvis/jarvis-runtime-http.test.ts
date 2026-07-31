// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { afterEach, assert, beforeEach, test, vi } from "vitest";
import { JarvisBus } from "./jarvis-bus";
import { HttpJarvisRuntime } from "./jarvis-runtime-http";
import { JarvisTaskStore } from "./jarvis-store";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(obj: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => obj,
    } as Response;
}

let bus: JarvisBus;
let store: JarvisTaskStore;
let calls: FetchCall[];
let responders: ((url: string, init: RequestInit) => Response | Promise<Response> | null)[];
let connStates: string[];
let runtime: HttpJarvisRuntime;

function makeRuntime(pollIntervalMs = 2000): HttpJarvisRuntime {
    return new HttpJarvisRuntime(store, bus, {
        baseUrl: "http://brain.test:8770/",
        token: "secret-token",
        pollIntervalMs,
        onConnectionChange: (s) => connStates.push(s),
        fetchFn: (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            for (const responder of responders) {
                const resp = responder(url, init);
                if (resp != null) {
                    return resp;
                }
            }
            return jsonResponse({});
        }) as typeof fetch,
    });
}

function respondTo(match: string, fn: (init: RequestInit) => unknown) {
    responders.push((url, init) => (url.includes(match) ? jsonResponse(fn(init)) : null));
}

beforeEach(() => {
    vi.useFakeTimers();
    bus = new JarvisBus();
    store = new JarvisTaskStore(bus);
    calls = [];
    responders = [];
    connStates = [];
    runtime = makeRuntime();
});

afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
});

test("submitPrompt posts /intent with payload, session and bearer token", async () => {
    respondTo("/intent", () => ({ handled: true, response: "listo", needs_confirmation: false, metadata: {} }));
    const taskId = await runtime.submitPrompt("qué tareas tengo", { project: "nexus" });
    const call = calls.find((c) => c.url === "http://brain.test:8770/intent");
    assert.notEqual(call, null);
    assert.equal(call.init.method, "POST");
    assert.equal((call.init.headers as Record<string, string>)["Authorization"], "Bearer secret-token");
    const body = JSON.parse(call.init.body as string);
    assert.equal(body.text, "qué tareas tengo");
    assert.equal(body.source, "workbench");
    assert.equal(body.project, "nexus");
    assert.match(body.session, /^wb-/);
    const task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "completed");
    assert.equal(task.result, "listo");
    assert.deepEqual(connStates, ["connected"]);
});

test("needs_confirmation maps to waiting-approval and approve posts 'sí'", async () => {
    respondTo("/intent", (init) => {
        const body = JSON.parse(init.body as string);
        if (body.text === "sí") {
            return { handled: true, response: "hecho", needs_confirmation: false, metadata: {} };
        }
        return { handled: true, response: "¿Confirmás borrar X?", needs_confirmation: true, metadata: {} };
    });
    const taskId = await runtime.submitPrompt("borrá X", {});
    let task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "waiting-approval");
    assert.equal(task.approval.action, "¿Confirmás borrar X?");

    runtime.approveTask(taskId);
    await vi.runAllTimersAsync();
    task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "completed");
    assert.equal(task.result, "hecho");
    const confirm = calls.filter((c) => c.url.endsWith("/intent")).map((c) => JSON.parse(c.init.body as string));
    assert.equal(confirm[confirm.length - 1].text, "sí");
    assert.equal(confirm[confirm.length - 1].source, "workbench");
});

test("rejectTask posts 'no' and cancels the task", async () => {
    respondTo("/intent", (init) => {
        const body = JSON.parse(init.body as string);
        if (body.text === "no") {
            return { handled: true, response: "ok, cancelado", needs_confirmation: false, metadata: {} };
        }
        return { handled: true, response: "¿Confirmás?", needs_confirmation: true, metadata: {} };
    });
    const taskId = await runtime.submitPrompt("acción sensible", {});
    runtime.rejectTask(taskId);
    await vi.runAllTimersAsync();
    const task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "cancelled");
    const bodies = calls.filter((c) => c.url.endsWith("/intent")).map((c) => JSON.parse(c.init.body as string));
    assert.equal(bodies[bodies.length - 1].text, "no");
});

test("llm_pending job: poll /llm/job + /inbox completes the task with the routed answer", async () => {
    respondTo("/intent", () => ({
        handled: true,
        response: "Pensando…",
        needs_confirmation: false,
        metadata: { llm_pending: true, job_id: "job-abc", model: "llama", conversation_id: "conv:x" },
    }));
    let jobState = "running";
    respondTo("/llm/job", () => ({ jobId: "job-abc", state: jobState, stale: false, error: null }));
    let inboxEntries: unknown[] = [];
    respondTo("/inbox", () => ({ responses: inboxEntries }));
    respondTo("/poll", () => ({ messages: [] }));

    const taskId = await runtime.submitPrompt("explicame el error", {});
    assert.equal(store.getTasks().find((t) => t.id === taskId).state, "running");

    runtime.attach();
    await vi.advanceTimersByTimeAsync(2100);
    assert.equal(store.getTasks().find((t) => t.id === taskId).state, "running");

    jobState = "completed";
    inboxEntries = [{ timestamp: 100, text: "el error es X", mode: "reply", origin_client: "workbench" }];
    await vi.advanceTimersByTimeAsync(2100);
    // first inbox read only sets the watermark... but the job was matched in the
    // same tick because the watermark starts on the FIRST inbox contact, which
    // happened above (empty inbox, watermark=0), so timestamp 100 is fresh.
    const task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "completed");
    assert.equal(task.result, "el error es X");
    runtime.detach();
});

test("proactive /poll messages surface as completed result tasks", async () => {
    respondTo("/poll", () => ({ messages: ["insight: la DB está lenta"] }));
    respondTo("/inbox", () => ({ responses: [] }));
    runtime.attach();
    await vi.advanceTimersByTimeAsync(10);
    const insight = store.getTasks().find((t) => t.title === "Mensaje proactivo de Jarvis");
    assert.notEqual(insight, null);
    assert.equal(insight.state, "completed");
    assert.equal(insight.result, "insight: la DB está lenta");
    runtime.detach();
});

test("network failure flips connection to disconnected and marks the task", async () => {
    responders.push(() => {
        throw new Error("ECONNREFUSED");
    });
    const taskId = await runtime.submitPrompt("hola", {});
    const task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "error");
    assert.deepEqual(connStates, ["disconnected"]);
});

test("cancelTask on an LLM job posts /llm/cancel; on a non-job task surfaces not-supported", async () => {
    respondTo("/intent", () => ({
        handled: true,
        response: "Pensando…",
        needs_confirmation: false,
        metadata: { llm_pending: true, job_id: "job-1" },
    }));
    respondTo("/llm/cancel", () => ({ cancelled: true }));
    const llmTask = await runtime.submitPrompt("pensá algo", {});
    runtime.cancelTask(llmTask);
    await vi.runAllTimersAsync();
    assert.equal(store.getTasks().find((t) => t.id === llmTask).state, "cancelled");
    const cancelCall = calls.find((c) => c.url.endsWith("/llm/cancel"));
    assert.equal(JSON.parse(cancelCall.init.body as string).id, "job-1");

    const errors: string[] = [];
    bus.on("jarvis.error", (e) => errors.push(e.message));
    runtime.cancelTask("task-that-is-not-a-job");
    assert.equal(errors.length, 1);
    assert.include(errors[0], "No soportado por el cerebro");
});

test("approve with an edited action is not supported: no fake success, task stays pending", async () => {
    respondTo("/intent", () => ({ handled: true, response: "¿Confirmás?", needs_confirmation: true, metadata: {} }));
    const taskId = await runtime.submitPrompt("acción", {});
    const errors: string[] = [];
    bus.on("jarvis.error", (e) => errors.push(e.message));
    const callsBefore = calls.length;
    runtime.approveTask(taskId, "otra acción distinta");
    assert.equal(calls.length, callsBefore);
    assert.equal(store.getTasks().find((t) => t.id === taskId).state, "waiting-approval");
    assert.equal(errors.length, 1);
    assert.include(errors[0], "No soportado por el cerebro");
});

test("polling only runs while attached", async () => {
    respondTo("/poll", () => ({ messages: [] }));
    respondTo("/inbox", () => ({ responses: [] }));
    runtime.attach();
    await vi.advanceTimersByTimeAsync(4200);
    const pollsWhileAttached = calls.filter((c) => c.url.includes("/poll")).length;
    assert.isAtLeast(pollsWhileAttached, 2);
    runtime.detach();
    await vi.advanceTimersByTimeAsync(6000);
    assert.equal(calls.filter((c) => c.url.includes("/poll")).length, pollsWhileAttached);
});
