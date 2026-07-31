// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// HttpJarvisRuntime (ADR-0007): the Jarvis block as a VIEW of the real brain
// (jarvisd, HTTP :8770, bearer token). Faithful mapping only — what the brain
// does not support (editing an approval action, cancelling non-LLM work,
// task progress) surfaces as not-supported, never as simulated success.
//
// Brain API mapping (Jarvis Protocol v1.1, docs/architecture/
// jarvis-protocol-v1.md in jarvis-openclaw-desktop):
//   submitPrompt  -> POST /intent {text, source:"workbench", session, project?}
//   approveTask   -> POST /intent {text:"sí"} (DialogueActResolver confirms the
//                    pending action of the SAME source channel)
//   rejectTask    -> POST /intent {text:"no"}
//   cancelTask    -> POST /llm/cancel {id} (LLM jobs only)
//   attach        -> POST /clients/register (workspace.* capabilities), then
//                    GET /events?client= (SSE) + one GET /state snapshot
//   SSE events    -> task.update (LLM job transitions), inbox.message (routed
//                    answers), state (proactive insights), mode.changed (bus),
//                    capability.invoke (execute + POST /capability/result),
//                    ping (liveness)
//   legacy poll   -> GET /poll + /llm/job + /inbox ONLY as fallback when the
//                    brain predates protocol v1.1 (404/501 on register/events)
//
// Wire dialect note: request/response fields of this protocol are snake_case
// (client_id, params_schema, invocation_id, …) because the contract is owned
// by the brain (Python). The repo's lowercase-JSON rule applies to Wave types,
// not to this external protocol.

import { JarvisBus } from "./jarvis-bus";
import {
    executeWorkspaceCapability,
    ModuleResolver,
    WorkspaceCapabilities,
    WorkspaceFacade,
} from "./jarvis-capabilities";
import { JarvisSseClient, SseUnsupportedError } from "./jarvis-sse";
import { JarvisTaskStore } from "./jarvis-store";
import { JarvisRuntime, JarvisTask, WorkbenchContext } from "./jarvis-types";

const OriginClient = "workbench";
const ClientType = "workbench";
const DefaultPollIntervalMs = 2000;
const HttpTimeoutMs = 10000;

export class HttpStatusError extends Error {
    status: number;

    constructor(status: number, path: string) {
        super(`brain HTTP ${status} on ${path}`);
        this.status = status;
    }
}

type CapabilityHost = {
    facade: WorkspaceFacade;
    resolveModule: ModuleResolver;
};

type HttpJarvisRuntimeConfig = {
    baseUrl: string;
    token?: string;
    onConnectionChange?: (state: "connected" | "disconnected") => void;
    pollIntervalMs?: number;
    fetchFn?: typeof fetch;
    capabilityHost?: CapabilityHost;
};

type LlmJobRef = {
    taskId: string;
    jobId: string;
};

let localCounter = 0;

function makeLocalTaskId(): string {
    localCounter++;
    return `jh-${Date.now().toString(36)}-${localCounter}`;
}

function taskTitle(prompt: string): string {
    const clean = prompt.trim().replace(/\s+/g, " ");
    return clean.length > 80 ? clean.slice(0, 77) + "…" : clean;
}

export class HttpJarvisRuntime implements JarvisRuntime {
    private baseUrl: string;
    private token: string;
    private onConnectionChange: (state: "connected" | "disconnected") => void;
    private pollIntervalMs: number;
    private fetchFn: typeof fetch;
    // session id doubles as the protocol client_id: stable while the renderer
    // lives, unique across renderers (spec §3.1 requires re-registration per
    // process anyway, the registry is in-memory brain-side).
    private sessionId = `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    private attachCount = 0;
    private active = false;
    private legacyMode = false;
    private sse: JarvisSseClient;
    private pollTimer: ReturnType<typeof setInterval> = null;
    private polling = false;
    private connected: boolean = null;
    private jobs: Map<string, LlmJobRef> = new Map(); // taskId -> job ref
    private awaitingInbox: LlmJobRef[] = [];
    private inboxWatermark: number = null; // brain journal timestamp (epoch seconds), legacy poll only
    private capabilityHost: CapabilityHost = null;

    constructor(
        private store: JarvisTaskStore,
        private bus: JarvisBus,
        config: HttpJarvisRuntimeConfig
    ) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.token = config.token ?? "";
        this.onConnectionChange = config.onConnectionChange ?? (() => {});
        this.pollIntervalMs = config.pollIntervalMs ?? DefaultPollIntervalMs;
        this.fetchFn = config.fetchFn ?? ((input, init) => fetch(input, init));
        this.capabilityHost = config.capabilityHost ?? null;
        this.sse = new JarvisSseClient({
            eventsUrl: `${this.baseUrl}/events?client=${encodeURIComponent(this.sessionId)}`,
            token: this.token,
            fetchFn: this.fetchFn,
            beforeConnect: () => this.registerClient(),
            onEvent: (event, data) => this.handleSseEvent(event, data),
            onConnected: () => {
                this.setConnected(true);
                // one snapshot per (re)connect (spec §6): replaces the poll
                // loop's steady-state reads; SSE replay covers the gap.
                void this.request("GET", "/state").catch(() => {});
            },
            onDisconnected: () => this.setConnected(false),
            onUnsupported: () => {
                // LEGACY FALLBACK: brain predates protocol v1.1 (no
                // /clients/register + /events). Transitional M1 polling until
                // the brain is upgraded; sticky for this process lifetime.
                this.legacyMode = true;
                if (this.active) {
                    this.startLegacyPolling();
                }
            },
        });
    }

    // -- transport ----------------------------------------------------------

    private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.token) {
            headers["Authorization"] = `Bearer ${this.token}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HttpTimeoutMs);
        let resp: Response;
        try {
            resp = await this.fetchFn(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: body != null ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (e) {
            this.setConnected(false);
            throw e;
        } finally {
            clearTimeout(timeout);
        }
        // any HTTP response (even an error status) proves the brain is alive
        this.setConnected(true);
        if (!resp.ok) {
            throw new HttpStatusError(resp.status, path);
        }
        return await resp.json();
    }

    private setConnected(connected: boolean) {
        if (this.connected === connected) {
            return;
        }
        this.connected = connected;
        this.onConnectionChange(connected ? "connected" : "disconnected");
    }

    // -- lifecycle (transports live only while a Jarvis block is mounted) ----

    attach(): void {
        this.attachCount++;
        if (this.active) {
            return;
        }
        this.active = true;
        if (this.legacyMode) {
            this.startLegacyPolling();
            return;
        }
        this.sse.start();
    }

    detach(): void {
        this.attachCount = Math.max(0, this.attachCount - 1);
        if (this.attachCount > 0 || !this.active) {
            return;
        }
        this.stopTransports();
    }

    dispose(): void {
        this.attachCount = 0;
        this.stopTransports();
    }

    private stopTransports(): void {
        this.active = false;
        this.sse.stop();
        if (this.pollTimer != null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    retryNow(): void {
        if (this.legacyMode) {
            void this.pollOnce();
            return;
        }
        if (this.active) {
            this.sse.retryNow();
            return;
        }
        // no block mounted: a lone probe so the UI can reflect reachability
        void this.request("GET", "/state").catch(() => {});
    }

    // -- protocol v1.1: registration + SSE -----------------------------------

    private async registerClient(): Promise<void> {
        try {
            await this.request("POST", "/clients/register", {
                client_id: this.sessionId,
                client_type: ClientType,
                capabilities: WorkspaceCapabilities,
            });
        } catch (e) {
            if (e instanceof HttpStatusError && (e.status === 404 || e.status === 501)) {
                throw new SseUnsupportedError(e.message);
            }
            throw e;
        }
    }

    private handleSseEvent(event: string, data: any): void {
        switch (event) {
            case "state":
                this.handleStateEvent(data);
                return;
            case "task.update":
                this.handleTaskUpdateEvent(data);
                return;
            case "inbox.message":
                this.handleInboxMessageEvent(data);
                return;
            case "mode.changed":
                this.bus.emit("mode.changed", {
                    mode: String(data?.mode ?? ""),
                    previous: data?.previous != null ? String(data.previous) : undefined,
                });
                return;
            case "capability.invoke":
                void this.handleCapabilityInvoke(data);
                return;
            case "ping":
                return;
            default:
                // spec §7: shells tolerate unknown event types
                return;
        }
    }

    // Broadcast brain activity. Proactive insights surface exactly like the
    // legacy /poll translation; turn echoes from other shells are ignored.
    private handleStateEvent(data: any): void {
        if (data?.activity !== "insights") {
            return;
        }
        for (const message of data?.messages ?? []) {
            const text = String(message);
            if (text) {
                this.surfaceMessage("Mensaje proactivo de Jarvis", text);
            }
        }
    }

    // Same job-state translation the legacy /llm/job poll performed. Only jobs
    // this runtime started are acted on (task.update is broadcast).
    private handleTaskUpdateEvent(data: any): void {
        if (data?.kind !== "llm_job") {
            return;
        }
        const jobId = String(data?.job_id ?? "");
        const ref = [...this.jobs.values()].find((r) => r.jobId === jobId);
        if (ref == null) {
            return;
        }
        const state = String(data?.state ?? "");
        if (state === "cancelled" || data?.stale) {
            this.jobs.delete(ref.taskId);
            this.store.updateTask(ref.taskId, {
                state: "cancelled",
                error: data?.stale ? "La conversación avanzó: respuesta descartada por el cerebro" : undefined,
            });
            return;
        }
        if (state === "failed" || state === "timed_out") {
            this.jobs.delete(ref.taskId);
            this.store.updateTask(ref.taskId, {
                state: "error",
                error: String(data?.error ?? "") || `trabajo LLM ${state === "timed_out" ? "expiró" : "falló"}`,
            });
            return;
        }
        if (state === "completed") {
            // the job event has no result text; the answer arrives as a
            // directed inbox.message on this same stream (ordered by cursor)
            this.jobs.delete(ref.taskId);
            this.awaitingInbox.push(ref);
        }
    }

    // Same translation the legacy /inbox poll performed; no watermark needed:
    // inbox.message is directed to this client_id and replay is cursor-based.
    private handleInboxMessageEvent(data: any): void {
        const text = String(data?.text ?? "");
        const ref = this.awaitingInbox.shift();
        if (ref != null) {
            this.store.updateTask(ref.taskId, { state: "completed", progress: 100, result: text });
            return;
        }
        if (text) {
            this.surfaceMessage("Respuesta de Jarvis", text);
        }
    }

    // -- capability.invoke: execute locally, ALWAYS answer the brain ---------

    private async getCapabilityHost(): Promise<CapabilityHost> {
        if (this.capabilityHost == null) {
            // lazy: the live bindings drag in Wave's store graph; tests inject
            // their own host and never load it
            const live = await import("./jarvis-capabilities-live");
            this.capabilityHost = { facade: live.liveWorkspaceFacade, resolveModule: live.resolveModuleRef };
        }
        return this.capabilityHost;
    }

    private async handleCapabilityInvoke(data: any): Promise<void> {
        const invocationId = String(data?.invocation_id ?? "");
        const capability = String(data?.capability ?? "");
        const args = data?.args != null && typeof data.args === "object" ? data.args : {};
        let outcome: { ok: true; result: Record<string, unknown> } | { ok: false; error: string };
        try {
            const host = await this.getCapabilityHost();
            const result = await executeWorkspaceCapability(capability, args, host.facade, host.resolveModule);
            outcome = { ok: true, result };
        } catch (e) {
            outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!invocationId) {
            return;
        }
        try {
            await this.request("POST", "/capability/result", { invocation_id: invocationId, ...outcome });
        } catch (e) {
            // the brain times the invocation out and audits it; nothing to fake
            console.warn("jarvis-runtime-http: no pude entregar /capability/result", e);
        }
    }

    // -- JarvisRuntime -------------------------------------------------------

    async submitPrompt(prompt: string, context: WorkbenchContext): Promise<string> {
        const taskId = makeLocalTaskId();
        const task: JarvisTask = {
            id: taskId,
            state: "queued",
            title: taskTitle(prompt),
            progress: 0,
            startedAt: Date.now(),
        };
        this.store.createTask(task);
        let body: any;
        try {
            body = await this.request("POST", "/intent", {
                text: prompt,
                source: OriginClient,
                session: this.sessionId,
                ...(context.project ? { project: context.project } : {}),
            });
        } catch (e) {
            this.store.updateTask(taskId, { state: "error", error: "cerebro no conectado" });
            return taskId;
        }
        this.applyIntentResult(taskId, body);
        return taskId;
    }

    private applyIntentResult(taskId: string, body: any) {
        const response = String(body?.response ?? "");
        const metadata = body?.metadata ?? {};
        if (body?.needs_confirmation) {
            this.store.updateTask(taskId, {
                state: "waiting-approval",
                approval: {
                    action: response,
                    // The brain does not expose a risk class on /intent; MEDIUM is
                    // the honest neutral (it asked for confirmation, so it is not LOW).
                    risk: "MEDIUM",
                    reason: "Confirmación pedida por el cerebro (respondé Approve=sí / Reject=no)",
                },
            });
            return;
        }
        if (metadata.llm_pending && metadata.job_id) {
            const ref: LlmJobRef = { taskId, jobId: String(metadata.job_id) };
            this.jobs.set(taskId, ref);
            // progress stays 0: the brain reports no task progress (ADR-0007).
            this.store.updateTask(taskId, { state: "running" });
            return;
        }
        if (body?.handled && response) {
            this.store.updateTask(taskId, { state: "completed", progress: 100, result: response });
            return;
        }
        this.store.updateTask(taskId, {
            state: "error",
            error: response || "El cerebro no pudo procesar el pedido (handled=false)",
        });
    }

    cancelTask(taskId: string): void {
        const ref = this.jobs.get(taskId);
        if (ref == null) {
            this.notSupported(taskId, "El cerebro solo soporta cancelar trabajos LLM en curso (/llm/cancel)");
            return;
        }
        this.request("POST", "/llm/cancel", { id: ref.jobId })
            .then((body) => {
                if (!body?.cancelled) {
                    this.bus.emit("jarvis.error", {
                        message: "El cerebro no pudo cancelar el trabajo",
                        taskId,
                    });
                    return;
                }
                this.jobs.delete(taskId);
                this.store.updateTask(taskId, { state: "cancelled" });
            })
            .catch(() => {
                this.bus.emit("jarvis.error", { message: "cerebro no conectado: no se pudo cancelar", taskId });
            });
    }

    approveTask(taskId: string, editedAction?: string): void {
        const task = this.store.getTasks().find((t) => t.id === taskId);
        if (task?.state !== "waiting-approval") {
            return;
        }
        if (editedAction != null && editedAction !== task.approval?.action) {
            this.notSupported(taskId, "El cerebro no soporta editar la acción antes de aprobarla");
            return;
        }
        this.confirmPending(taskId, "sí", "running");
    }

    rejectTask(taskId: string): void {
        const task = this.store.getTasks().find((t) => t.id === taskId);
        if (task?.state !== "waiting-approval") {
            return;
        }
        this.confirmPending(taskId, "no", "cancelled");
    }

    // Approvals in the brain are conversational (DialogueActResolver): a bare
    // "sí"/"no" from the SAME source channel resolves the pending action.
    private confirmPending(taskId: string, text: "sí" | "no", optimisticState: "running" | "cancelled") {
        if (text === "no") {
            // terminal state up-front: the rejection was decided by the operator,
            // the request below only informs the brain.
            this.store.updateTask(taskId, { state: "cancelled", error: "Acción rechazada por el operador" });
        } else {
            this.store.updateTask(taskId, { state: optimisticState });
        }
        this.request("POST", "/intent", { text, source: OriginClient, session: this.sessionId })
            .then((body) => {
                if (text === "no") {
                    return;
                }
                this.applyIntentResult(taskId, body);
            })
            .catch(() => {
                if (text === "no") {
                    this.bus.emit("jarvis.error", {
                        message: "cerebro no conectado: el rechazo no llegó al cerebro",
                        taskId,
                    });
                    return;
                }
                this.store.updateTask(taskId, { state: "error", error: "cerebro no conectado" });
            });
    }

    private notSupported(taskId: string, message: string) {
        console.warn(`jarvis-runtime-http: ${message} (task ${taskId})`);
        this.bus.emit("jarvis.error", { message: `No soportado por el cerebro: ${message}`, taskId });
    }

    // Surfacing a brain message that arrived outside a tracked task: created
    // then completed in two steps so the store emits resultReady for the UI.
    private surfaceMessage(title: string, text: string) {
        const id = makeLocalTaskId();
        this.store.createTask({ id, state: "queued", title, progress: 0, startedAt: Date.now() });
        this.store.updateTask(id, { state: "completed", progress: 100, result: text });
    }

    // -- LEGACY poll loop ----------------------------------------------------
    // Kept ONLY for brains that predate protocol v1.1 (register/events answer
    // 404/501). M2 of ADR-0007 replaced this with the SSE channel above.

    private startLegacyPolling(): void {
        if (this.pollTimer != null) {
            return;
        }
        this.pollTimer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
        void this.pollOnce();
    }

    private async pollOnce(): Promise<void> {
        if (this.polling) {
            return;
        }
        this.polling = true;
        try {
            await this.pollProactive();
            await this.pollJobs();
            await this.pollInbox();
        } catch (e) {
            // request() already flipped the connection state; nothing else to do.
        } finally {
            this.polling = false;
        }
    }

    // GET /poll drains proactive insights. Each message becomes a completed
    // task so the UI surfaces it as an unseen result.
    private async pollProactive(): Promise<void> {
        const body = await this.request("GET", "/poll");
        for (const message of body?.messages ?? []) {
            const text = String(message);
            if (text) {
                this.surfaceMessage("Mensaje proactivo de Jarvis", text);
            }
        }
    }

    private async pollJobs(): Promise<void> {
        for (const ref of [...this.jobs.values()]) {
            const body = await this.request("GET", `/llm/job?id=${encodeURIComponent(ref.jobId)}`);
            const state = String(body?.state ?? "");
            if (state === "cancelled" || body?.stale) {
                this.jobs.delete(ref.taskId);
                this.store.updateTask(ref.taskId, {
                    state: "cancelled",
                    error: body?.stale ? "La conversación avanzó: respuesta descartada por el cerebro" : undefined,
                });
                continue;
            }
            if (state === "failed" || state === "timed_out") {
                this.jobs.delete(ref.taskId);
                this.store.updateTask(ref.taskId, {
                    state: "error",
                    error: String(body?.error ?? "") || `trabajo LLM ${state === "timed_out" ? "expiró" : "falló"}`,
                });
                continue;
            }
            if (state === "completed") {
                // The job snapshot has no result text; the answer is routed to
                // this client's inbox (ResponseRouter). Match it there.
                this.jobs.delete(ref.taskId);
                this.awaitingInbox.push(ref);
            }
        }
    }

    private async pollInbox(): Promise<void> {
        if (this.awaitingInbox.length === 0 && this.inboxWatermark != null) {
            return;
        }
        const body = await this.request("GET", `/inbox?client=${OriginClient}`);
        const entries: any[] = body?.responses ?? [];
        if (this.inboxWatermark == null) {
            // First contact: everything already in the inbox predates this view.
            this.inboxWatermark = entries.reduce((max, e) => Math.max(max, Number(e?.timestamp ?? 0)), 0);
            return;
        }
        const fresh = entries
            .filter((e) => Number(e?.timestamp ?? 0) > this.inboxWatermark)
            .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
        for (const entry of fresh) {
            this.inboxWatermark = Math.max(this.inboxWatermark, Number(entry.timestamp));
            const ref = this.awaitingInbox.shift();
            const text = String(entry?.text ?? "");
            if (ref != null) {
                this.store.updateTask(ref.taskId, { state: "completed", progress: 100, result: text });
                continue;
            }
            if (text) {
                this.surfaceMessage("Respuesta de Jarvis", text);
            }
        }
    }
}
