// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import { DefaultBrainUrl, resolveBrainConfig, sameBrainConfig } from "./jarvis-brain-config";

test("sin settings ni env: el default local hace que no haya nada que configurar", () => {
    const cfg = resolveBrainConfig({}, {});
    assert.equal(cfg.mode, "http");
    assert.equal(cfg.url, DefaultBrainUrl);
    assert.equal(cfg.token, "");
});

test("precedencia url: setting > env > default", () => {
    assert.equal(
        resolveBrainConfig({ url: "http://desde-setting:8770" }, { url: "http://desde-env:8770" }).url,
        "http://desde-setting:8770"
    );
    assert.equal(resolveBrainConfig({}, { url: "http://desde-env:8770" }).url, "http://desde-env:8770");
    assert.equal(resolveBrainConfig({}, {}).url, DefaultBrainUrl);
});

test("precedencia token: setting > env > vacío", () => {
    assert.equal(resolveBrainConfig({ token: "s3cr3t" }, { token: "del-env" }).token, "s3cr3t");
    assert.equal(resolveBrainConfig({}, { token: "del-env" }).token, "del-env");
    assert.equal(resolveBrainConfig({}, {}).token, "");
});

test("un setting en blanco no gana: cae al env y después al default", () => {
    const cfg = resolveBrainConfig({ url: "   ", token: "  " }, { url: "http://desde-env:8770", token: "t" });
    assert.equal(cfg.url, "http://desde-env:8770");
    assert.equal(cfg.token, "t");
    assert.equal(resolveBrainConfig({ url: "  " }, {}).url, DefaultBrainUrl);
});

test("enabled=false es la ÚNICA puerta al mock", () => {
    const cfg = resolveBrainConfig({ enabled: false, url: "http://x:8770", token: "t" }, { url: "http://y:8770" });
    assert.equal(cfg.mode, "mock");
    assert.equal(cfg.url, "");
    assert.equal(cfg.token, "");
    // enabled ausente o true = cerebro real
    assert.equal(resolveBrainConfig({}, {}).mode, "http");
    assert.equal(resolveBrainConfig({ enabled: true }, {}).mode, "http");
});

test("un cerebro inalcanzable NO se degrada a mock (eso lo decide la sonda, no la config)", () => {
    assert.equal(resolveBrainConfig({ url: "http://192.0.2.1:8770" }, {}).mode, "http");
});

test("sameBrainConfig distingue exactamente lo que obliga a reconstruir el runtime", () => {
    const base = resolveBrainConfig({ url: "http://a:8770", token: "t" }, {});
    assert.isTrue(sameBrainConfig(base, resolveBrainConfig({ url: "http://a:8770", token: "t" }, {})));
    assert.isFalse(sameBrainConfig(base, resolveBrainConfig({ url: "http://b:8770", token: "t" }, {})));
    assert.isFalse(sameBrainConfig(base, resolveBrainConfig({ url: "http://a:8770", token: "otro" }, {})));
    assert.isFalse(sameBrainConfig(base, resolveBrainConfig({ enabled: false }, {})));
    assert.isTrue(sameBrainConfig(null, null));
    assert.isFalse(sameBrainConfig(base, null));
});
