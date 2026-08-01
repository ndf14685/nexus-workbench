// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Reconfiguración en caliente del runtime (D-027): cambiar de cerebro NO puede
// exigir reiniciar el Workbench ni tirar abajo el store/bus.

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, assert, beforeEach, test, vi } from "vitest";
import { JarvisBrainConfig } from "./jarvis-brain-config";

let currentConfig: JarvisBrainConfig = { mode: "mock", url: "", token: "" };
let settingsListener: () => void = null;

vi.mock("./jarvis-context", () => ({
    getJarvisBrainConfig: () => currentConfig,
    loadJarvisBrainEnv: async () => ({}),
    subscribeJarvisBrainSettings: (cb: () => void) => {
        settingsListener = cb;
        return () => {
            settingsListener = null;
        };
    },
    WorkbenchContextProvider: class {
        start() {}
        stop() {}
        getContext() {
            return {};
        }
    },
}));

import { JarvisCore } from "./jarvis-core";
import { HttpJarvisRuntime } from "./jarvis-runtime-http";
import { MockJarvisRuntime } from "./jarvis-runtime-mock";

function setConfig(config: JarvisBrainConfig) {
    currentConfig = config;
}

beforeEach(() => {
    // ningún test toca la red: la sonda y el SSE fallan y eso es lo esperado
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            throw new Error("offline");
        })
    );
    setConfig({ mode: "mock", url: "", token: "" });
    JarvisCore.resetInstance();
});

afterEach(() => {
    JarvisCore.resetInstance();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test("mock -> http: reemplaza el runtime, destruye el viejo y queda desconectado (no 'live')", () => {
    const core = JarvisCore.getInstance();
    assert.instanceOf(core.runtime, MockJarvisRuntime);
    assert.equal(globalStore.get(core.connectionAtom), "mock");

    const old = core.runtime;
    const disposeSpy = vi.spyOn(old, "dispose");
    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "" });
    core.reconfigure();

    assert.instanceOf(core.runtime, HttpJarvisRuntime);
    assert.notEqual(core.runtime, old);
    assert.equal(disposeSpy.mock.calls.length, 1);
    assert.equal(globalStore.get(core.connectionAtom), "disconnected");
});

test("misma config: no reconstruye nada (sin churn de reconexión)", () => {
    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "t" });
    const core = JarvisCore.getInstance();
    const runtime = core.runtime;
    const disposeSpy = vi.spyOn(runtime, "dispose");

    core.reconfigure();
    core.reconfigure();
    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "t" });
    core.reconfigure();

    assert.equal(core.runtime, runtime);
    assert.equal(disposeSpy.mock.calls.length, 0);
});

test("http -> http con otra url/token: swap limpio conservando store y bus", () => {
    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "" });
    const core = JarvisCore.getInstance();
    const store = core.store;
    const bus = core.bus;
    const old = core.runtime;
    const disposeSpy = vi.spyOn(old, "dispose");

    setConfig({ mode: "http", url: "http://otro-host:8770", token: "nuevo" });
    core.reconfigure();
    assert.notEqual(core.runtime, old);
    assert.equal(disposeSpy.mock.calls.length, 1);

    // solo cambia el token: también obliga a reconstruir
    const second = core.runtime;
    setConfig({ mode: "http", url: "http://otro-host:8770", token: "rotado" });
    core.reconfigure();
    assert.notEqual(core.runtime, second);

    // la identidad del bloque (store/bus/atoms) sobrevive a los dos swaps
    assert.equal(core.store, store);
    assert.equal(core.bus, bus);
});

test("http -> mock: apagar el cerebro devuelve el preview etiquetado", () => {
    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "" });
    const core = JarvisCore.getInstance();
    assert.instanceOf(core.runtime, HttpJarvisRuntime);

    setConfig({ mode: "mock", url: "", token: "" });
    core.reconfigure();
    assert.instanceOf(core.runtime, MockJarvisRuntime);
    assert.equal(globalStore.get(core.connectionAtom), "mock");
});

test("las vistas montadas se re-attachean al runtime nuevo", () => {
    const attachSpy = vi.spyOn(HttpJarvisRuntime.prototype, "attach");
    const core = JarvisCore.getInstance();
    core.attachView();
    core.attachView();
    assert.equal(core.viewCount, 2);

    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "" });
    core.reconfigure();
    assert.equal(attachSpy.mock.calls.length, 2);

    core.detachView();
    assert.equal(core.viewCount, 1);
});

test("un cambio de settings reconfigura sin que nadie llame a reconfigure()", () => {
    const core = JarvisCore.getInstance();
    assert.instanceOf(core.runtime, MockJarvisRuntime);
    assert.isFunction(settingsListener);

    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "" });
    settingsListener();
    assert.instanceOf(core.runtime, HttpJarvisRuntime);
});

test("un runtime ya reemplazado no puede seguir moviendo el estado de conexión", () => {
    setConfig({ mode: "http", url: "http://127.0.0.1:8770", token: "" });
    const core = JarvisCore.getInstance();
    const old = core.runtime as any;

    setConfig({ mode: "mock", url: "", token: "" });
    core.reconfigure();
    assert.equal(globalStore.get(core.connectionAtom), "mock");

    // el viejo adapter emite tarde (una respuesta HTTP en vuelo)
    old.onConnectionChange("connected");
    assert.equal(globalStore.get(core.connectionAtom), "mock");
});
