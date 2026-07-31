// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// SSE client for the Jarvis Protocol v1.1 event channel (GET /events).
// Implemented over fetch + ReadableStream because EventSource cannot send the
// Authorization bearer header the brain requires. The framing parser is a pure
// function (fed arbitrary chunk splits) so it is unit-testable in isolation.
//
// Wire contract: docs/architecture/jarvis-protocol-v1.md (jarvis-openclaw-
// desktop). Frames are `id:` (global integer cursor) + `event:` + `data:`
// (one-line JSON) + blank line. Reconnection passes `?since=<last id>` and the
// brain replays from its 1000-event ring buffer.

const ReconnectDelaysMs = [1000, 2000, 5000, 10000];
// ~3 missed pings (brain pings every ~15 s): the socket is dead even if TCP
// has not noticed yet.
const DefaultIdleTimeoutMs = 45000;

export type JarvisSseFrame = {
    id: string | null;
    event: string;
    data: string;
};

export type JarvisSseParser = {
    feed: (chunk: string) => void;
};

// Incremental SSE framing parser. Tolerates chunk boundaries anywhere
// (mid-line, mid-field), CRLF line endings, comment lines (":...") and
// multi-line data (joined with \n, though the brain always sends one line).
export function makeSseParser(onFrame: (frame: JarvisSseFrame) => void): JarvisSseParser {
    let buffer = "";
    let id: string = null;
    let event: string = null;
    let dataLines: string[] = [];

    const flush = () => {
        if (id == null && event == null && dataLines.length === 0) {
            return;
        }
        onFrame({ id, event: event ?? "message", data: dataLines.join("\n") });
        id = null;
        event = null;
        dataLines = [];
    };

    const handleLine = (line: string) => {
        if (line === "") {
            flush();
            return;
        }
        if (line.startsWith(":")) {
            return;
        }
        const sep = line.indexOf(":");
        const field = sep < 0 ? line : line.slice(0, sep);
        let value = sep < 0 ? "" : line.slice(sep + 1);
        if (value.startsWith(" ")) {
            value = value.slice(1);
        }
        if (field === "id") {
            id = value;
        } else if (field === "event") {
            event = value;
        } else if (field === "data") {
            dataLines.push(value);
        }
    };

    return {
        feed(chunk: string) {
            buffer += chunk;
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                let line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.endsWith("\r")) {
                    line = line.slice(0, -1);
                }
                handleLine(line);
            }
        },
    };
}

// Thrown (or reported) when the brain does not speak protocol v1.1 (404/501
// on /events or /clients/register): the caller falls back to legacy polling.
export class SseUnsupportedError extends Error {}

type JarvisSseClientConfig = {
    eventsUrl: string; // absolute /events URL, already carrying ?client=<id>
    token?: string;
    fetchFn?: typeof fetch;
    // Runs before every (re)connection attempt; the runtime re-registers the
    // client here (the brain's registry is in-memory, spec §3.1). Throwing
    // SseUnsupportedError aborts permanently; any other throw retries.
    beforeConnect?: () => Promise<void>;
    onEvent: (event: string, data: any, id: number | null) => void;
    onConnected: () => void;
    onDisconnected: () => void;
    onUnsupported: () => void;
    idleTimeoutMs?: number;
};

export class JarvisSseClient {
    private eventsUrl: string;
    private token: string;
    private fetchFn: typeof fetch;
    private beforeConnect: () => Promise<void>;
    private onEvent: (event: string, data: any, id: number | null) => void;
    private onConnected: () => void;
    private onDisconnected: () => void;
    private onUnsupported: () => void;
    private idleTimeoutMs: number;

    private started = false;
    private connecting = false;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> = null;
    private idleTimer: ReturnType<typeof setTimeout> = null;
    private abortController: AbortController = null;
    private currentReader: { read: () => Promise<any>; cancel: () => Promise<any> } = null;

    lastEventId: number = null;

    constructor(config: JarvisSseClientConfig) {
        this.eventsUrl = config.eventsUrl;
        this.token = config.token ?? "";
        this.fetchFn = config.fetchFn ?? ((input, init) => fetch(input, init));
        this.beforeConnect = config.beforeConnect ?? (async () => {});
        this.onEvent = config.onEvent;
        this.onConnected = config.onConnected;
        this.onDisconnected = config.onDisconnected;
        this.onUnsupported = config.onUnsupported;
        this.idleTimeoutMs = config.idleTimeoutMs ?? DefaultIdleTimeoutMs;
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        this.attempt = 0;
        void this.connect();
    }

    stop(): void {
        this.started = false;
        if (this.reconnectTimer != null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.clearIdleTimer();
        this.abortController?.abort();
        this.currentReader?.cancel().catch(() => {});
    }

    retryNow(): void {
        if (!this.started || this.connecting) {
            return;
        }
        if (this.reconnectTimer != null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        void this.connect();
    }

    private async connect(): Promise<void> {
        this.connecting = true;
        try {
            await this.beforeConnect();
            const sep = this.eventsUrl.includes("?") ? "&" : "?";
            const url = this.lastEventId != null ? `${this.eventsUrl}${sep}since=${this.lastEventId}` : this.eventsUrl;
            const headers: Record<string, string> = { Accept: "text/event-stream" };
            if (this.token) {
                headers["Authorization"] = `Bearer ${this.token}`;
            }
            this.abortController = new AbortController();
            const resp = await this.fetchFn(url, { method: "GET", headers, signal: this.abortController.signal });
            if (resp.status === 404 || resp.status === 501) {
                throw new SseUnsupportedError(`sse HTTP ${resp.status}`);
            }
            if (!resp.ok || resp.body == null) {
                throw new Error(`sse HTTP ${resp.status}`);
            }
            this.onConnected();
            await this.readStream(resp.body);
        } catch (e) {
            if (e instanceof SseUnsupportedError) {
                this.started = false;
                this.connecting = false;
                this.onUnsupported();
                return;
            }
        } finally {
            this.connecting = false;
            this.clearIdleTimer();
        }
        if (!this.started) {
            return;
        }
        this.onDisconnected();
        this.scheduleReconnect();
    }

    private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader();
        this.currentReader = reader;
        const decoder = new TextDecoder();
        const parser = makeSseParser((frame) => this.handleFrame(frame));
        this.armIdleTimer();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    return;
                }
                this.armIdleTimer();
                // string chunks are accepted so tests can drive the stream
                // without constructing Uint8Array payloads
                parser.feed(typeof value === "string" ? value : decoder.decode(value, { stream: true }));
            }
        } finally {
            this.currentReader = null;
        }
    }

    private handleFrame(frame: JarvisSseFrame): void {
        // a live frame proves the brain is healthy: reset the backoff ladder
        this.attempt = 0;
        if (frame.id != null && /^\d+$/.test(frame.id)) {
            this.lastEventId = parseInt(frame.id, 10);
        }
        let data: any = {};
        if (frame.data) {
            try {
                data = JSON.parse(frame.data);
            } catch (e) {
                data = { raw: frame.data };
            }
        }
        this.onEvent(frame.event, data, this.lastEventId);
    }

    private scheduleReconnect(): void {
        const delay = ReconnectDelaysMs[Math.min(this.attempt, ReconnectDelaysMs.length - 1)];
        this.attempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }

    private armIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.abortController?.abort();
            this.currentReader?.cancel().catch(() => {});
        }, this.idleTimeoutMs);
    }

    private clearIdleTimer(): void {
        if (this.idleTimer != null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}
