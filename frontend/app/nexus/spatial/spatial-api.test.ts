// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { assert, beforeEach, test, vi } from "vitest";

const rpcCalls: [string, any][] = [];

vi.mock("@/app/store/wshclientapi", () => {
    const record = (command: string, ret?: any) => {
        return (_client: any, data?: any) => {
            rpcCalls.push([command, data]);
            return Promise.resolve(ret);
        };
    };
    return {
        RpcApi: {
            SpatialFocusCommand: record("SpatialFocusCommand"),
            SpatialRestoreCommand: record("SpatialRestoreCommand"),
            SpatialDetachCommand: record("SpatialDetachCommand", "surf-1"),
            SpatialAttachCommand: record("SpatialAttachCommand"),
            SpatialMoveCommand: record("SpatialMoveCommand"),
            SpatialSetMinimizedCommand: record("SpatialSetMinimizedCommand"),
            SpatialCloseModuleCommand: record("SpatialCloseModuleCommand"),
            SpatialListMonitorsCommand: record("SpatialListMonitorsCommand", []),
            SpatialSaveProfileCommand: record("SpatialSaveProfileCommand"),
            SpatialLoadProfileCommand: record("SpatialLoadProfileCommand"),
            SpatialListProfilesCommand: record("SpatialListProfilesCommand", ["incident-response"]),
            SpatialGetStateCommand: record("SpatialGetStateCommand", null),
            DeleteBlockCommand: record("DeleteBlockCommand"),
        },
    };
});

import { workspace } from "./spatial-api";
import { getSpatialBus, resetSpatialBus } from "./spatial-bus";
import { SpatialModel } from "./spatial-model";

let traced: { command: string; args: any }[] = [];

beforeEach(() => {
    rpcCalls.length = 0;
    traced = [];
    SpatialModel.resetInstance();
    resetSpatialBus();
    getSpatialBus().on("jarvis.commandReceived", (p) => traced.push(p as any));
});

function lastRpc(): [string, any] {
    return rpcCalls[rpcCalls.length - 1];
}

test("focusModule calls SpatialFocusCommand and traces", async () => {
    await workspace.focusModule("blk-1");
    assert.deepEqual(lastRpc(), ["SpatialFocusCommand", { moduleid: "blk-1" }]);
    assert.deepEqual(traced, [{ command: "focusModule", args: { moduleId: "blk-1" } }]);
});

test("restoreModule calls SpatialRestoreCommand and traces", async () => {
    await workspace.restoreModule("blk-1");
    assert.deepEqual(lastRpc(), ["SpatialRestoreCommand", { moduleid: "blk-1" }]);
    assert.equal(traced[0].command, "restoreModule");
});

test("detachModule passes opts, returns surfaceId and traces", async () => {
    const placement = { x: 1, y: 2, width: 300, height: 200 };
    const surfaceId = await workspace.detachModule("blk-1", { monitorId: "mon-1", placement, fill: true });
    assert.equal(surfaceId, "surf-1");
    assert.deepEqual(lastRpc(), [
        "SpatialDetachCommand",
        { moduleid: "blk-1", monitorid: "mon-1", placement, fill: true },
    ]);
    assert.deepEqual(traced[0], { command: "detachModule", args: { moduleId: "blk-1", monitorId: "mon-1", placement, fill: true } });
});

test("attachModule calls SpatialAttachCommand and traces", async () => {
    await workspace.attachModule("blk-1");
    assert.deepEqual(lastRpc(), ["SpatialAttachCommand", { moduleid: "blk-1" }]);
    assert.equal(traced[0].command, "attachModule");
});

test("moveModule passes monitor/placement target and traces", async () => {
    await workspace.moveModule("blk-1", { monitorId: "mon-2" });
    assert.deepEqual(lastRpc(), ["SpatialMoveCommand", { moduleid: "blk-1", monitorid: "mon-2", placement: undefined }]);
    assert.equal(traced[0].command, "moveModule");
});

test("minimizeModule calls SpatialSetMinimizedCommand and traces", async () => {
    await workspace.minimizeModule("blk-1", true);
    assert.deepEqual(lastRpc(), ["SpatialSetMinimizedCommand", { moduleid: "blk-1", minimized: true }]);
    assert.deepEqual(traced[0], { command: "minimizeModule", args: { moduleId: "blk-1", minimized: true } });
});

test("closeModule: docked delegates to standard DeleteBlockCommand", async () => {
    await workspace.closeModule("blk-docked");
    assert.deepEqual(lastRpc(), ["DeleteBlockCommand", { blockid: "blk-docked" }]);
    assert.equal(traced[0].command, "closeModule");
});

test("closeModule: detached goes through the spatial engine", async () => {
    SpatialModel.getInstance().handleWpsEvent({
        event: "spatial:update",
        scopes: ["workspace:ws-1"],
        data: {
            type: "module.detached",
            workspaceid: "ws-1",
            moduleid: "blk-1",
            surfaceid: "surf-1",
            payload: { id: "surf-1", type: "detachedwindow", renderertype: "desktop", createdts: 0, updatedts: 0 },
        },
    } as WaveEvent);
    await workspace.closeModule("blk-1");
    assert.deepEqual(lastRpc(), ["SpatialCloseModuleCommand", { moduleid: "blk-1" }]);
});

test("listMonitors calls SpatialListMonitorsCommand and traces", async () => {
    const monitors = await workspace.listMonitors();
    assert.deepEqual(monitors, []);
    assert.equal(lastRpc()[0], "SpatialListMonitorsCommand");
    assert.equal(traced[0].command, "listMonitors");
});

test("saveLayout targets the model workspace and traces", async () => {
    SpatialModel.getInstance().workspaceId = "ws-1";
    await workspace.saveLayout("Incident Response");
    assert.deepEqual(lastRpc(), ["SpatialSaveProfileCommand", { name: "Incident Response", workspaceid: "ws-1" }]);
    assert.deepEqual(traced[0], { command: "saveLayout", args: { profileName: "Incident Response" } });
});

test("loadLayout targets the model workspace and traces", async () => {
    SpatialModel.getInstance().workspaceId = "ws-1";
    await workspace.loadLayout("Incident Response");
    assert.deepEqual(lastRpc(), ["SpatialLoadProfileCommand", { name: "Incident Response", workspaceid: "ws-1" }]);
    assert.equal(traced[0].command, "loadLayout");
});

test("listLayouts returns profile slugs and traces", async () => {
    const layouts = await workspace.listLayouts();
    assert.deepEqual(layouts, ["incident-response"]);
    assert.equal(lastRpc()[0], "SpatialListProfilesCommand");
    assert.equal(traced[0].command, "listLayouts");
});
