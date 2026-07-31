// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { assert, beforeEach, test } from "vitest";
import { getSpatialBus, resetSpatialBus, SpatialBus } from "./spatial-bus";
import { applySpatialMenu, buildSpatialMenuItems } from "./spatial-menu";
import { makeSurfaceNodeModel } from "./surface-node-model";
import { isDetachedModule, shouldPreserveBlockOnDelete, SpatialModel } from "./spatial-model";

function makeUpdateEvent(data: { type: string } & Partial<SpatialEventData>): WaveEvent {
    return {
        event: "spatial:update",
        scopes: ["workspace:ws-1"],
        data: { workspaceid: "ws-1", ...data },
    } as WaveEvent;
}

function makeSurface(id: string): Surface {
    return {
        id,
        type: "detachedwindow",
        renderertype: "desktop",
        createdts: 0,
        updatedts: 0,
    };
}

beforeEach(() => {
    SpatialModel.resetInstance();
    resetSpatialBus();
});

test("bus delivers typed events and unsubscribes cleanly", () => {
    const bus = new SpatialBus();
    const seen: string[] = [];
    const off = bus.on("module.created", (p) => seen.push(p.moduleId));
    bus.emit("module.created", { moduleId: "blk-1" });
    off();
    bus.emit("module.created", { moduleId: "blk-2" });
    assert.deepEqual(seen, ["blk-1"]);
});

test("bus survives a throwing handler", () => {
    const bus = new SpatialBus();
    const seen: string[] = [];
    bus.on("surface.closed", () => {
        throw new Error("boom");
    });
    bus.on("surface.closed", (p) => seen.push(p.surfaceId));
    bus.emit("surface.closed", { surfaceId: "surf-1" });
    assert.deepEqual(seen, ["surf-1"]);
});

test("WPS bridge re-emits each SpatialEventData type as a typed bus event", () => {
    const model = SpatialModel.getInstance();
    const seen: [string, any][] = [];
    const bus = getSpatialBus();
    bus.on("module.detached", (p) => seen.push(["module.detached", p]));
    bus.on("module.attached", (p) => seen.push(["module.attached", p]));
    bus.on("module.moved", (p) => seen.push(["module.moved", p]));

    model.handleWpsEvent(
        makeUpdateEvent({ type: "module.detached", moduleid: "blk-1", surfaceid: "surf-1", payload: makeSurface("surf-1") as any })
    );
    model.handleWpsEvent(
        makeUpdateEvent({ type: "module.moved", moduleid: "blk-1", payload: { x: 5, y: 6, width: 700, height: 500 } as any })
    );
    model.handleWpsEvent(makeUpdateEvent({ type: "module.attached", moduleid: "blk-1" }));

    assert.equal(seen.length, 3);
    assert.equal(seen[0][0], "module.detached");
    assert.equal(seen[0][1].moduleId, "blk-1");
    assert.equal(seen[0][1].surface.id, "surf-1");
    assert.equal(seen[1][0], "module.moved");
    assert.equal(seen[1][1].placement.width, 700);
    assert.equal(seen[2][0], "module.attached");
    assert.equal(seen[2][1].moduleId, "blk-1");
});

test("WPS bridge parses JSON-string payloads", () => {
    const model = SpatialModel.getInstance();
    let placement: SpatialPlacement = null;
    getSpatialBus().on("module.resized", (p) => (placement = p.placement));
    model.handleWpsEvent(
        makeUpdateEvent({ type: "module.resized", moduleid: "blk-1", payload: JSON.stringify({ x: 1, y: 2, width: 300, height: 200 }) })
    );
    assert.notEqual(placement, null);
    assert.equal(placement.height, 200);
});

test("WPS bridge ignores malformed events without throwing", () => {
    const model = SpatialModel.getInstance();
    model.handleWpsEvent({ event: "spatial:update" } as WaveEvent);
    model.handleWpsEvent(makeUpdateEvent({ type: "not.a.real.event", moduleid: "blk-1" }));
    assert.equal(globalStore.get(model.detachedModuleIdsAtom).size, 0);
});

test("detachedModuleIdsAtom derives from state on detach/attach events", () => {
    const model = SpatialModel.getInstance();
    model.handleWpsEvent(
        makeUpdateEvent({ type: "module.detached", moduleid: "blk-1", surfaceid: "surf-1", payload: makeSurface("surf-1") as any })
    );
    model.handleWpsEvent(
        makeUpdateEvent({ type: "module.detached", moduleid: "blk-2", surfaceid: "surf-2", payload: makeSurface("surf-2") as any })
    );

    let detached = globalStore.get(model.detachedModuleIdsAtom);
    assert.deepEqual([...detached].sort(), ["blk-1", "blk-2"]);
    const st = globalStore.get(model.spatialStateAtom);
    assert.equal(st.modules["blk-1"].currentsurfaceid, "surf-1");
    assert.notEqual(st.surfaces["surf-2"], null);

    model.handleWpsEvent(makeUpdateEvent({ type: "module.attached", moduleid: "blk-1" }));
    detached = globalStore.get(model.detachedModuleIdsAtom);
    assert.deepEqual([...detached], ["blk-2"]);
    assert.isUndefined(globalStore.get(model.spatialStateAtom).surfaces["surf-1"]);
});

test("isDetachedModule guards layout cleanup for detached blocks", () => {
    assert.equal(isDetachedModule("blk-1"), false);
    const model = SpatialModel.getInstance();
    model.handleWpsEvent(
        makeUpdateEvent({ type: "module.detached", moduleid: "blk-1", surfaceid: "surf-1", payload: makeSurface("surf-1") as any })
    );
    assert.equal(isDetachedModule("blk-1"), true);
    assert.equal(isDetachedModule("blk-docked"), false);

    model.handleWpsEvent(makeUpdateEvent({ type: "module.attached", moduleid: "blk-1" }));
    assert.equal(isDetachedModule("blk-1"), false);
});

test("shouldPreserveBlockOnDelete: backend delete of a detached block must not DeleteBlock", () => {
    assert.equal(shouldPreserveBlockOnDelete("blk-1"), false);
    const model = SpatialModel.getInstance();
    model.handleWpsEvent(
        makeUpdateEvent({ type: "module.detached", moduleid: "blk-1", surfaceid: "surf-1", payload: makeSurface("surf-1") as any })
    );
    assert.equal(shouldPreserveBlockOnDelete("blk-1"), true);
    assert.equal(shouldPreserveBlockOnDelete("blk-docked"), false);

    model.handleWpsEvent(makeUpdateEvent({ type: "module.attached", moduleid: "blk-1" }));
    assert.equal(shouldPreserveBlockOnDelete("blk-1"), false);
});

test("attach for unknown module is a safe no-op", () => {
    const model = SpatialModel.getInstance();
    model.handleWpsEvent(makeUpdateEvent({ type: "module.attached", moduleid: "ghost" }));
    assert.equal(globalStore.get(model.spatialStateAtom), null);
});

function detachModuleForTest(moduleId: string, surfaceId: string) {
    SpatialModel.getInstance().handleWpsEvent(
        makeUpdateEvent({
            type: "module.detached",
            moduleid: moduleId,
            surfaceid: surfaceId,
            payload: makeSurface(surfaceId) as any,
        })
    );
}

test("spatial menu: docked shows Pop Out only", () => {
    const items = buildSpatialMenuItems("blk-docked");
    assert.deepEqual(
        items.map((it) => it.label),
        ["Desacoplar (Pop Out)"]
    );
});

test("spatial menu: detached shows Pop In only", () => {
    detachModuleForTest("blk-1", "surf-1");
    const items = buildSpatialMenuItems("blk-1");
    assert.deepEqual(
        items.map((it) => it.label),
        ["Acoplar a ventana principal"]
    );
});

test("spatial menu: visibility flips after attach", () => {
    detachModuleForTest("blk-1", "surf-1");
    SpatialModel.getInstance().handleWpsEvent(makeUpdateEvent({ type: "module.attached", moduleid: "blk-1" }));
    const items = buildSpatialMenuItems("blk-1");
    assert.deepEqual(
        items.map((it) => it.label),
        ["Desacoplar (Pop Out)"]
    );
});

test("applySpatialMenu appends items to a docked header menu", () => {
    const base: ContextMenuItem[] = [
        { label: "Magnify Block", click: () => {} },
        { type: "separator" },
        { label: "Close Block", click: () => {} },
    ];
    const menu = applySpatialMenu(base, "blk-docked");
    assert.deepEqual(
        menu.map((it) => it.label ?? "|"),
        ["Magnify Block", "|", "Close Block", "|", "Desacoplar (Pop Out)"]
    );
});

test("applySpatialMenu prunes tab-centric actions when detached (R11)", () => {
    detachModuleForTest("blk-1", "surf-1");
    const base: ContextMenuItem[] = [
        { label: "Magnify Block", click: () => {} },
        { type: "separator" },
        { label: "Copy BlockId", click: () => {} },
        { type: "separator" },
        { label: "Close Block", click: () => {} },
    ];
    const menu = applySpatialMenu(base, "blk-1");
    assert.deepEqual(
        menu.map((it) => it.label ?? "|"),
        ["Copy BlockId", "|", "Acoplar a ventana principal"]
    );
});

test("synthetic surface NodeModel satisfies the interface without a LayoutModel", () => {
    const nm = makeSurfaceNodeModel("blk-1");
    assert.equal(nm.blockId, "blk-1");
    assert.equal(nm.nodeId, "blk-1");
    assert.equal(globalStore.get(nm.isFocused), true);
    assert.equal(globalStore.get(nm.isMagnified), false);
    assert.equal(globalStore.get(nm.anyMagnified), false);
    assert.equal(globalStore.get(nm.isEphemeral), false);
    assert.equal(globalStore.get(nm.isResizing), false);
    assert.equal(globalStore.get(nm.disablePointerEvents), false);
    assert.equal(globalStore.get(nm.ready), true);
    assert.equal(globalStore.get(nm.numLeafs), 1);
    assert.equal(globalStore.get(nm.blockNum), 1);
    assert.doesNotThrow(() => nm.focusNode());
    assert.doesNotThrow(() => nm.toggleMagnify());
    assert.doesNotThrow(() => nm.addEphemeralNodeToLayout());
    assert.doesNotThrow(() => nm.onClose());
    assert.notEqual(nm.displayContainerRef, null);
});
