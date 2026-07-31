// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { afterEach, assert, beforeEach, test, vi } from "vitest";
import { JarvisBus } from "./jarvis-bus";
import { WorkspaceFacade } from "./jarvis-capabilities";
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

type PushStream = {
    push: (text: string) => void;
    close: () => void;
    body: any;
};

function makeStream(): PushStream {
    const pending: { resolve: (v: any) => void }[] = [];
    const queue: string[] = [];
    let closed = false;
    const tryFlush = () => {
        while (pending.length > 0 && (queue.length > 0 || closed)) {
            const p = pending.shift();
            if (queue.length > 0) {
                p.resolve({ done: false, value: queue.shift() });
            } else {
                p.resolve({ done: true, value: undefined });
            }
        }
    };
    return {
        push(text: string) {
            queue.push(text);
            tryFlush();
        },
        close() {
            closed = true;
            tryFlush();
        },
        body: {
            getReader() {
                return {
                    read: () =>
                        new Promise<any>((resolve) => {
                            pending.push({ resolve });
                            tryFlush();
                        }),
                    cancel: async () => {
                        closed = true;
                        tryFlush();
                    },
                };
            },
        },
    };
}

function frame(id: number, event: string, data: unknown): string {
    return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

let bus: JarvisBus;
let store: JarvisTaskStore;
let calls: FetchCall[];
let responders: ((url: string, init: RequestInit) => Response | Promise<Response> | null)[];
let connStates: string[];
let runtime: HttpJarvisRuntime;

type RuntimeExtra = {
    capabilityHost?: { facade: WorkspaceFacade; resolveModule: (ref: string) => string | null };
};

function makeRuntime(pollIntervalMs = 2000, extra: RuntimeExtra = {}): HttpJarvisRuntime {
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
        ...extra,
    });
}

function respondTo(match: string, fn: (init: RequestInit) => unknown) {
    responders.push((url, init) => (url.includes(match) ? jsonResponse(fn(init)) : null));
}

function respondStatus(match: string, status: number) {
    responders.push((url) => (url.includes(match) ? jsonResponse({ error: "not_found" }, status) : null));
}

// Wires the protocol v1.1 happy path: registration ok, /state snapshot, and an
// /events SSE stream the test can push frames into.
function setupSse(): PushStream {
    const stream = makeStream();
    respondTo("/clients/register", () => ({ ok: true, registered: 9 }));
    respondTo("/state", () => ({}));
    responders.push((url) => (url.includes("/events?") ? ({ ok: true, status: 200, body: stream.body } as any) : null));
    return stream;
}

// Older brain without protocol v1.1: register 404s, the runtime must fall back
// to the legacy transitional polling.
function setupLegacyBrain() {
    respondStatus("/clients/register", 404);
    respondStatus("/events?", 404);
}

async function flushAsync(times = 8) {
    for (let i = 0; i < times; i++) {
        await vi.advanceTimersByTimeAsync(0);
    }
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

// -- intent channel (v1.0, unchanged) ----------------------------------------

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

// -- protocol v1.1: registration + SSE ---------------------------------------

test("attach registers the client (workspace.* capabilities) and opens SSE with one /state snapshot", async () => {
    setupSse();
    runtime.attach();
    await flushAsync();

    const reg = calls.find((c) => c.url.endsWith("/clients/register"));
    assert.notEqual(reg, null);
    assert.equal(reg.init.method, "POST");
    const body = JSON.parse(reg.init.body as string);
    assert.match(body.client_id, /^wb-/);
    assert.equal(body.client_type, "workbench");
    const names = body.capabilities.map((c: any) => c.name);
    assert.deepEqual(names, [
        "workspace.loadLayout",
        "workspace.saveLayout",
        "workspace.focusModule",
        "workspace.restoreModule",
        "workspace.detachModule",
        "workspace.attachModule",
        "workspace.moveModule",
        "workspace.listMonitors",
        "workspace.listLayouts",
    ]);
    for (const cap of body.capabilities) {
        assert.isString(cap.description);
        assert.equal(cap.params_schema.type, "object");
        assert.include(["read", "reversible-write"], cap.risk_class);
    }
    assert.equal(body.capabilities.find((c: any) => c.name === "workspace.listMonitors").risk_class, "read");
    assert.equal(body.capabilities.find((c: any) => c.name === "workspace.listLayouts").risk_class, "read");
    assert.equal(body.capabilities.find((c: any) => c.name === "workspace.loadLayout").risk_class, "reversible-write");

    const evCall = calls.find((c) => c.url.includes("/events?client="));
    assert.notEqual(evCall, null);
    assert.include(evCall.url, encodeURIComponent(body.client_id));
    assert.include(connStates, "connected");
    assert.notEqual(
        calls.find((c) => c.url.endsWith("/state")),
        null
    );
    // the transitional poll loop is gone in v1.1 mode
    assert.equal(calls.filter((c) => c.url.includes("/poll")).length, 0);
});

test("SSE task.update completed + inbox.message complete the llm task; foreign jobs ignored", async () => {
    const stream = setupSse();
    respondTo("/intent", () => ({
        handled: true,
        response: "Pensando…",
        needs_confirmation: false,
        metadata: { llm_pending: true, job_id: "job-abc" },
    }));
    runtime.attach();
    await flushAsync();
    const taskId = await runtime.submitPrompt("explicame el error", {});
    assert.equal(store.getTasks().find((t) => t.id === taskId).state, "running");

    const tasksBefore = store.getTasks().length;
    stream.push(frame(1, "task.update", { kind: "llm_job", job_id: "job-de-otro-shell", state: "completed" }));
    await flushAsync();
    assert.equal(store.getTasks().length, tasksBefore);

    stream.push(frame(2, "task.update", { kind: "llm_job", job_id: "job-abc", state: "completed", model: "llama" }));
    stream.push(frame(3, "inbox.message", { timestamp: 100, text: "el error es X", mode: "reply", origin_client: "workbench" }));
    await flushAsync();
    const task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "completed");
    assert.equal(task.result, "el error es X");
});

test("SSE task.update failed/stale map to error/cancelled", async () => {
    const stream = setupSse();
    let jobCounter = 0;
    respondTo("/intent", () => ({
        handled: true,
        response: "Pensando…",
        needs_confirmation: false,
        metadata: { llm_pending: true, job_id: `job-${++jobCounter}` },
    }));
    runtime.attach();
    await flushAsync();
    const failedTask = await runtime.submitPrompt("uno", {});
    const staleTask = await runtime.submitPrompt("dos", {});

    stream.push(frame(1, "task.update", { kind: "llm_job", job_id: "job-1", state: "failed", error: "modelo caído" }));
    stream.push(frame(2, "task.update", { kind: "llm_job", job_id: "job-2", state: "completed", stale: true }));
    await flushAsync();
    const failed = store.getTasks().find((t) => t.id === failedTask);
    assert.equal(failed.state, "error");
    assert.equal(failed.error, "modelo caído");
    const stale = store.getTasks().find((t) => t.id === staleTask);
    assert.equal(stale.state, "cancelled");
});

test("SSE state insights surface as completed result tasks", async () => {
    const stream = setupSse();
    runtime.attach();
    await flushAsync();
    stream.push(frame(1, "state", { activity: "insights", messages: ["insight: la DB está lenta"] }));
    stream.push(frame(2, "state", { activity: "turn", client_type: "hud", handled: true }));
    await flushAsync();
    const insight = store.getTasks().find((t) => t.title === "Mensaje proactivo de Jarvis");
    assert.notEqual(insight, null);
    assert.equal(insight.state, "completed");
    assert.equal(insight.result, "insight: la DB está lenta");
    assert.equal(store.getTasks().length, 1);
});

test("SSE inbox.message without a tracked job surfaces as a brain answer", async () => {
    const stream = setupSse();
    runtime.attach();
    await flushAsync();
    stream.push(frame(1, "inbox.message", { timestamp: 5, text: "aviso suelto", mode: "notify", origin_client: "workbench" }));
    await flushAsync();
    const surfaced = store.getTasks().find((t) => t.title === "Respuesta de Jarvis");
    assert.equal(surfaced.result, "aviso suelto");
});

test("SSE mode.changed is emitted on the jarvis bus", async () => {
    const stream = setupSse();
    const modes: { mode: string; previous?: string }[] = [];
    bus.on("mode.changed", (m) => modes.push(m));
    runtime.attach();
    await flushAsync();
    stream.push(frame(1, "mode.changed", { mode: "focus", previous: "normal" }));
    await flushAsync();
    assert.deepEqual(modes, [{ mode: "focus", previous: "normal" }]);
});

test("SSE stream drop flips connection to disconnected", async () => {
    const stream = setupSse();
    runtime.attach();
    await flushAsync();
    assert.include(connStates, "connected");
    stream.close();
    await flushAsync();
    assert.equal(connStates[connStates.length - 1], "disconnected");
});

// -- capability.invoke -> workspace facade -----------------------------------

type FacadeHarness = {
    facade: WorkspaceFacade;
    facadeCalls: [string, unknown[]][];
};

function makeFacade(overrides: Partial<WorkspaceFacade> = {}): FacadeHarness {
    const facadeCalls: [string, unknown[]][] = [];
    const record =
        (name: string, ret?: unknown) =>
        async (...args: unknown[]) => {
            facadeCalls.push([name, args]);
            return ret as any;
        };
    const facade: WorkspaceFacade = {
        loadLayout: record("loadLayout"),
        saveLayout: record("saveLayout"),
        focusModule: record("focusModule"),
        restoreModule: record("restoreModule"),
        detachModule: record("detachModule", "surf-1") as any,
        attachModule: record("attachModule"),
        moveModule: record("moveModule"),
        listMonitors: record("listMonitors", [{ monitorid: "m1" }]) as any,
        listLayouts: record("listLayouts", ["dev", "focus"]) as any,
        ...overrides,
    };
    return { facade, facadeCalls };
}

function resolveForTest(ref: string): string | null {
    if (ref === "jarvis") {
        return "blk-jarvis";
    }
    if (ref.startsWith("blk-")) {
        return ref;
    }
    return null;
}

function capabilityResults(): any[] {
    return calls.filter((c) => c.url.endsWith("/capability/result")).map((c) => JSON.parse(c.init.body as string));
}

test("capability.invoke dispatches to the facade and POSTs ok result", async () => {
    const { facade, facadeCalls } = makeFacade();
    runtime.dispose();
    runtime = makeRuntime(2000, { capabilityHost: { facade, resolveModule: resolveForTest } });
    const stream = setupSse();
    respondTo("/capability/result", () => ({ ok: true }));
    runtime.attach();
    await flushAsync();

    stream.push(frame(1, "capability.invoke", { invocation_id: "inv-1", capability: "workspace.loadLayout", args: { name: "dev" } }));
    await flushAsync();
    assert.deepEqual(facadeCalls, [["loadLayout", ["dev"]]]);
    assert.deepEqual(capabilityResults(), [{ invocation_id: "inv-1", ok: true, result: { loaded: true, name: "dev" } }]);
});

test("capability.invoke resolves friendly module refs and blockIds", async () => {
    const { facade, facadeCalls } = makeFacade();
    runtime.dispose();
    runtime = makeRuntime(2000, { capabilityHost: { facade, resolveModule: resolveForTest } });
    const stream = setupSse();
    respondTo("/capability/result", () => ({ ok: true }));
    runtime.attach();
    await flushAsync();

    stream.push(frame(1, "capability.invoke", { invocation_id: "inv-1", capability: "workspace.focusModule", args: { moduleid: "jarvis" } }));
    stream.push(frame(2, "capability.invoke", { invocation_id: "inv-2", capability: "workspace.detachModule", args: { moduleid: "blk-7", monitorid: "m2" } }));
    stream.push(frame(3, "capability.invoke", { invocation_id: "inv-3", capability: "workspace.listLayouts", args: {} }));
    await flushAsync();
    assert.deepEqual(facadeCalls, [
        ["focusModule", ["blk-jarvis"]],
        ["detachModule", ["blk-7", { monitorId: "m2" }]],
        ["listLayouts", []],
    ]);
    assert.deepEqual(capabilityResults(), [
        { invocation_id: "inv-1", ok: true, result: { focused: "blk-jarvis" } },
        { invocation_id: "inv-2", ok: true, result: { detached: "blk-7", surface: "surf-1" } },
        { invocation_id: "inv-3", ok: true, result: { layouts: ["dev", "focus"] } },
    ]);
});

test("capability.invoke error paths always answer the brain with ok:false", async () => {
    const { facade } = makeFacade({
        saveLayout: async () => {
            throw new Error("disco lleno");
        },
    });
    runtime.dispose();
    runtime = makeRuntime(2000, { capabilityHost: { facade, resolveModule: resolveForTest } });
    const stream = setupSse();
    respondTo("/capability/result", () => ({ ok: true }));
    runtime.attach();
    await flushAsync();

    stream.push(frame(1, "capability.invoke", { invocation_id: "inv-1", capability: "workspace.nope", args: {} }));
    stream.push(frame(2, "capability.invoke", { invocation_id: "inv-2", capability: "workspace.saveLayout", args: { name: "dev" } }));
    stream.push(frame(3, "capability.invoke", { invocation_id: "inv-3", capability: "workspace.focusModule", args: { moduleid: "no-existe" } }));
    stream.push(frame(4, "capability.invoke", { invocation_id: "inv-4", capability: "workspace.loadLayout", args: {} }));
    await flushAsync();
    const results = capabilityResults();
    assert.equal(results.length, 4);
    assert.equal(results[0].ok, false);
    assert.include(results[0].error, "capability desconocida");
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error, "disco lleno");
    assert.equal(results[2].ok, false);
    assert.include(results[2].error, "módulo desconocido");
    assert.equal(results[3].ok, false);
    assert.include(results[3].error, "falta el argumento 'name'");
});

// -- legacy fallback (brain without protocol v1.1) ---------------------------

test("register 404 falls back to legacy polling: /poll + /llm/job + /inbox still work", async () => {
    setupLegacyBrain();
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
    const task = store.getTasks().find((t) => t.id === taskId);
    assert.equal(task.state, "completed");
    assert.equal(task.result, "el error es X");
    runtime.detach();
});

test("legacy fallback: proactive /poll messages surface as completed result tasks", async () => {
    setupLegacyBrain();
    respondTo("/poll", () => ({ messages: ["insight: la DB está lenta"] }));
    respondTo("/inbox", () => ({ responses: [] }));
    runtime.attach();
    await flushAsync();
    const insight = store.getTasks().find((t) => t.title === "Mensaje proactivo de Jarvis");
    assert.notEqual(insight, null);
    assert.equal(insight.state, "completed");
    assert.equal(insight.result, "insight: la DB está lenta");
    runtime.detach();
});

test("legacy fallback: polling only runs while attached", async () => {
    setupLegacyBrain();
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
