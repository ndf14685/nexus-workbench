// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node

import net from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WSControl } from "./ws";

// wsutil picks the Node `ws` client (the one the Electron main process uses)
// through a dynamic import; awaiting the same module guarantees it resolved
async function nodeWsReady() {
    await import("ws");
    await new Promise((resolve) => setTimeout(resolve, 0));
}

// a port that was just released: nothing listens, connect() is refused
async function closedPort(): Promise<number> {
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
}

let controls: WSControl[] = [];

afterEach(() => {
    for (const ctl of controls) {
        ctl.shutdown();
    }
    controls = [];
});

describe("WSControl under Node ws (Electron main process)", () => {
    it("keeps an error listener so a refused connection cannot become an uncaught exception", async () => {
        await nodeWsReady();
        const port = await closedPort();
        const ctl = new WSControl(`ws://127.0.0.1:${port}`, "electron-test", () => {}, { authKey: "k" });
        controls.push(ctl);

        ctl.connectNow("test");

        // Node ws is an EventEmitter: an 'error' with no listener is rethrown
        // and Electron's uncaughtException handler quits the whole app
        const conn = ctl.wsConn as any;
        expect(typeof conn.listenerCount).toBe("function");
        expect(conn.listenerCount("error")).toBeGreaterThan(0);

        // the refused connection still closes and schedules a reconnect
        await vi.waitFor(() => expect(ctl.reconnectTimes).toBeGreaterThan(0), { timeout: 5000 });
    });
});
