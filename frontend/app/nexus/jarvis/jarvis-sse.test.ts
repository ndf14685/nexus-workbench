// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { afterEach, assert, test, vi } from "vitest";
import { JarvisSseClient, JarvisSseFrame, makeSseParser, SseUnsupportedError } from "./jarvis-sse";

// -- parser (pure) -----------------------------------------------------------

function collectFrames() {
    const frames: JarvisSseFrame[] = [];
    const parser = makeSseParser((f) => frames.push(f));
    return { frames, parser };
}

test("sse parser: parses a complete id/event/data frame", () => {
    const { frames, parser } = collectFrames();
    parser.feed('id: 12\nevent: inbox.message\ndata: {"text": "hola"}\n\n');
    assert.deepEqual(frames, [{ id: "12", event: "inbox.message", data: '{"text": "hola"}' }]);
});

test("sse parser: tolerates chunk splits mid-line and mid-field", () => {
    const { frames, parser } = collectFrames();
    parser.feed("id: 4");
    parser.feed("2\neve");
    parser.feed("nt: ping\nda");
    parser.feed("ta: {}\n");
    assert.equal(frames.length, 0);
    parser.feed("\n");
    assert.deepEqual(frames, [{ id: "42", event: "ping", data: "{}" }]);
});

test("sse parser: CRLF endings, comment lines and multiple frames per chunk", () => {
    const { frames, parser } = collectFrames();
    parser.feed(':keepalive\r\nid: 1\r\nevent: state\r\ndata: {"n":1}\r\n\r\nid: 2\nevent: task.update\ndata: {"n":2}\n\n');
    assert.deepEqual(frames, [
        { id: "1", event: "state", data: '{"n":1}' },
        { id: "2", event: "task.update", data: '{"n":2}' },
    ]);
});

test("sse parser: blank lines without fields emit nothing", () => {
    const { frames, parser } = collectFrames();
    parser.feed("\n\n\n");
    assert.equal(frames.length, 0);
});

// -- client (fetch + stream + backoff) ---------------------------------------

type PushStream = {
    push: (text: string) => void;
    close: () => void;
    body: ReadableStream<Uint8Array>;
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
                    read: () => new Promise<any>((resolve) => {
                        pending.push({ resolve });
                        tryFlush();
                    }),
                    cancel: async () => {
                        closed = true;
                        tryFlush();
                    },
                };
            },
        } as any,
    };
}

async function flushAsync(times = 6) {
    for (let i = 0; i < times; i++) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

type ClientHarness = {
    client: JarvisSseClient;
    urls: string[];
    events: { event: string; data: any; id: number | null }[];
    states: string[];
    unsupported: () => number;
};

function makeClient(fetchFn: (url: string, init: RequestInit) => Promise<any>, beforeConnect?: () => Promise<void>): ClientHarness {
    const urls: string[] = [];
    const events: { event: string; data: any; id: number | null }[] = [];
    const states: string[] = [];
    let unsupportedCount = 0;
    const client = new JarvisSseClient({
        eventsUrl: "http://brain.test:8770/events?client=wb-1",
        token: "tok",
        fetchFn: (async (url: string, init: RequestInit) => {
            urls.push(url);
            return fetchFn(url, init);
        }) as typeof fetch,
        beforeConnect,
        onEvent: (event, data, id) => events.push({ event, data, id }),
        onConnected: () => states.push("connected"),
        onDisconnected: () => states.push("disconnected"),
        onUnsupported: () => unsupportedCount++,
    });
    return { client, urls, events, states, unsupported: () => unsupportedCount };
}

afterEach(() => {
    vi.useRealTimers();
});

test("sse client: sends bearer header, parses events, reconnects with ?since=<last id>", async () => {
    vi.useFakeTimers();
    let stream = makeStream();
    let lastAuth: string = null;
    const h = makeClient(async (_url, init) => {
        lastAuth = (init.headers as Record<string, string>)["Authorization"];
        return { ok: true, status: 200, body: stream.body };
    });
    h.client.start();
    await flushAsync();
    assert.equal(lastAuth, "Bearer tok");
    assert.equal(h.states[0], "connected");

    stream.push('id: 7\nevent: inbox.message\ndata: {"text": "hola"}\n\n');
    await flushAsync();
    assert.deepEqual(h.events, [{ event: "inbox.message", data: { text: "hola" }, id: 7 }]);
    assert.equal(h.client.lastEventId, 7);

    const oldStream = stream;
    stream = makeStream();
    oldStream.close();
    await flushAsync();
    assert.include(h.states, "disconnected");
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(h.urls.length, 2);
    assert.include(h.urls[1], "client=wb-1");
    assert.include(h.urls[1], "&since=7");
    h.client.stop();
});

test("sse client: reconnect backoff ladder 1s, 2s, 5s, 10s then capped at 10s", async () => {
    vi.useFakeTimers();
    const h = makeClient(async () => {
        throw new Error("ECONNREFUSED");
    });
    h.client.start();
    await flushAsync();
    assert.equal(h.urls.length, 1);
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(h.urls.length, 2);
    await vi.advanceTimersByTimeAsync(2000);
    assert.equal(h.urls.length, 3);
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(h.urls.length, 4);
    await vi.advanceTimersByTimeAsync(10000);
    assert.equal(h.urls.length, 5);
    await vi.advanceTimersByTimeAsync(10000);
    assert.equal(h.urls.length, 6);
    // half a step: no early attempt
    await vi.advanceTimersByTimeAsync(4000);
    assert.equal(h.urls.length, 6);
    h.client.stop();
});

test("sse client: 404 on /events reports unsupported and stops retrying", async () => {
    vi.useFakeTimers();
    const h = makeClient(async () => ({ ok: false, status: 404, body: null }));
    h.client.start();
    await flushAsync();
    assert.equal(h.unsupported(), 1);
    await vi.advanceTimersByTimeAsync(30000);
    assert.equal(h.urls.length, 1);
});

test("sse client: SseUnsupportedError from beforeConnect skips the stream entirely", async () => {
    vi.useFakeTimers();
    const h = makeClient(
        async () => ({ ok: true, status: 200, body: makeStream().body }),
        async () => {
            throw new SseUnsupportedError("register 404");
        }
    );
    h.client.start();
    await flushAsync();
    assert.equal(h.unsupported(), 1);
    assert.equal(h.urls.length, 0);
});

test("sse client: idle watchdog reconnects a silent stream", async () => {
    vi.useFakeTimers();
    let stream = makeStream();
    const h = makeClient(async () => ({ ok: true, status: 200, body: stream.body }));
    h.client.start();
    await flushAsync();
    assert.equal(h.urls.length, 1);
    stream = makeStream();
    // 45s without frames (3 missed pings) must abort and reconnect
    await vi.advanceTimersByTimeAsync(45001);
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(h.urls.length, 2);
    h.client.stop();
});
