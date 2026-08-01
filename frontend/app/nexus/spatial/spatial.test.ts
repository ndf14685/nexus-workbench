// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { modalsModel } from "@/store/modalmodel";
import { assert, beforeEach, test } from "vitest";
import { getSpatialBus, resetSpatialBus, SpatialBus } from "./spatial-bus";
import {
    applySpatialMenu,
    applySpatialMenuAsync,
    buildMonitorSubmenu,
    buildProfileSubmenu,
    buildSpatialMenuItems,
    saveProfileAs,
} from "./spatial-menu";
import { makeSurfaceNodeModel } from "./surface-node-model";
import {
    decideDockedFocusAction,
    decideDockedFocusReleaseAction,
    hasFocusSnapshot,
    isDetachedModule,
    shouldPreserveBlockOnDelete,
    SpatialModel,
} from "./spatial-model";

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
    RpcApi.setMockRpcClient(null);
});

function installRpcRecorder(profileList: string[] = []): [string, any][] {
    const calls: [string, any][] = [];
    RpcApi.setMockRpcClient({
        mockWshRpcCall: (_client, command, data) => {
            calls.push([command, data]);
            if (command === "spatiallistprofiles") {
                return Promise.resolve(profileList);
            }
            return Promise.resolve(null);
        },
        mockWshRpcStream: null,
    });
    return calls;
}

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

const DockedBaseLabels = ["Desacoplar (Pop Out)", "Enfocar módulo", "Maximizar módulo"];
const DetachedBaseLabels = ["Acoplar a ventana principal", "Enfocar módulo", "Maximizar módulo", "Minimizar módulo", "Cerrar módulo"];
const ProfileTailLabels = ["|", "Guardar layout como perfil…", "Cargar perfil"];

function labelOf(it: ContextMenuItem): string {
    return it.label ?? "|";
}

test("spatial menu: docked shows Pop Out + Focus + Maximize", () => {
    const items = buildSpatialMenuItems("blk-docked");
    assert.deepEqual(items.map(labelOf), [...DockedBaseLabels, ...ProfileTailLabels]);
});

test("spatial menu: detached shows Pop In, Focus, Maximize, Minimize, Close", () => {
    detachModuleForTest("blk-1", "surf-1");
    const items = buildSpatialMenuItems("blk-1");
    assert.deepEqual(items.map(labelOf), [...DetachedBaseLabels, ...ProfileTailLabels]);
});

function makeMonitor(monitorid: string, label: string, primary: boolean): MonitorInfo {
    return {
        monitorid,
        displayid: 1,
        label,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workarea: { x: 0, y: 30, width: 1920, height: 1050 },
        scalefactor: 1,
        primary,
        internal: false,
    };
}

test("spatial menu: detached with monitor catalog shows Move to Monitor submenu", () => {
    detachModuleForTest("blk-1", "surf-1");
    const monitors = [makeMonitor("A|1920x1080@1", "A", true), makeMonitor("B|1920x1080@1", "B", false)];
    const items = buildSpatialMenuItems("blk-1", monitors);
    assert.deepEqual(items.map(labelOf), [
        "Acoplar a ventana principal",
        "Mover a monitor",
        "Enfocar módulo",
        "Maximizar módulo",
        "Minimizar módulo",
        "Cerrar módulo",
        ...ProfileTailLabels,
    ]);
    const submenu = items.find((it) => it.label === "Mover a monitor");
    assert.equal(submenu.type, "submenu");
    assert.equal(submenu.submenu.length, 2);
});

test("buildMonitorSubmenu: labels, principal marker, current disabled, click selects", () => {
    const monitors = [makeMonitor("A|1920x1080@1", "A", true), makeMonitor("B|1920x1080@1", "B", false), makeMonitor("77|1024x768@1", "", false)];
    const selected: string[] = [];
    const items = buildMonitorSubmenu(monitors, "B|1920x1080@1", (monitorId) => selected.push(monitorId));
    assert.deepEqual(
        items.map((it) => it.label),
        ["A (principal)", "B", "Monitor 1"]
    );
    assert.deepEqual(
        items.map((it) => it.enabled),
        [true, false, true]
    );
    items[0].click();
    items[2].click();
    assert.deepEqual(selected, ["A|1920x1080@1", "77|1024x768@1"]);
});

test("buildMonitorSubmenu: empty catalog yields no items", () => {
    assert.deepEqual(buildMonitorSubmenu([], "", () => {}), []);
    assert.deepEqual(buildMonitorSubmenu(null, "", () => {}), []);
});

test("module.moved delta updates placement and monitor in state", () => {
    const model = SpatialModel.getInstance();
    detachModuleForTest("blk-1", "surf-1");
    model.handleWpsEvent(
        makeUpdateEvent({
            type: "module.moved",
            moduleid: "blk-1",
            monitorid: "B|1920x1080@1",
            payload: { x: 100, y: 200, width: 800, height: 600 } as any,
        })
    );
    const st = globalStore.get(model.spatialStateAtom);
    assert.equal(st.modules["blk-1"].monitorid, "B|1920x1080@1");
    assert.equal(st.modules["blk-1"].placement.x, 100);
    assert.equal(model.getModuleMonitorId("blk-1"), "B|1920x1080@1");
    // moved de un módulo desconocido no crea entradas fantasma
    model.handleWpsEvent(makeUpdateEvent({ type: "module.moved", moduleid: "ghost", payload: { x: 1, y: 1, width: 10, height: 10 } as any }));
    assert.isUndefined(globalStore.get(model.spatialStateAtom).modules["ghost"]);
});

test("spatial menu: visibility flips after attach", () => {
    detachModuleForTest("blk-1", "surf-1");
    SpatialModel.getInstance().handleWpsEvent(makeUpdateEvent({ type: "module.attached", moduleid: "blk-1" }));
    const items = buildSpatialMenuItems("blk-1");
    assert.deepEqual(items.map(labelOf), [...DockedBaseLabels, ...ProfileTailLabels]);
});

test("spatial menu: Restore appears only while a focus snapshot exists", () => {
    const model = SpatialModel.getInstance();
    assert.equal(hasFocusSnapshot("blk-1"), false);
    model.handleWpsEvent(
        makeUpdateEvent({
            type: "module.focused",
            moduleid: "blk-1",
            payload: { moduleid: "blk-1", wasdetached: false, capturedts: 5 } as any,
        })
    );
    assert.equal(hasFocusSnapshot("blk-1"), true);
    let labels = buildSpatialMenuItems("blk-1").map(labelOf);
    assert.deepEqual(labels, [
        "Desacoplar (Pop Out)",
        "Enfocar módulo",
        "Restaurar posición anterior",
        "Maximizar módulo",
        ...ProfileTailLabels,
    ]);

    model.handleWpsEvent(makeUpdateEvent({ type: "module.focusReleased", moduleid: "blk-1" }));
    assert.equal(hasFocusSnapshot("blk-1"), false);
    labels = buildSpatialMenuItems("blk-1").map(labelOf);
    assert.deepEqual(labels, [...DockedBaseLabels, ...ProfileTailLabels]);
});

test("focus snapshot delta also works for detached modules", () => {
    const model = SpatialModel.getInstance();
    detachModuleForTest("blk-1", "surf-1");
    model.handleWpsEvent(
        makeUpdateEvent({
            type: "module.focused",
            moduleid: "blk-1",
            payload: { moduleid: "blk-1", wasdetached: true, capturedts: 7 } as any,
        })
    );
    assert.equal(hasFocusSnapshot("blk-1"), true);
    const labels = buildSpatialMenuItems("blk-1").map(labelOf);
    assert.deepEqual(labels, [
        "Acoplar a ventana principal",
        "Enfocar módulo",
        "Restaurar posición anterior",
        "Maximizar módulo",
        "Minimizar módulo",
        "Cerrar módulo",
        ...ProfileTailLabels,
    ]);
    // focusReleased de un detached conserva la entrada del módulo
    model.handleWpsEvent(makeUpdateEvent({ type: "module.focusReleased", moduleid: "blk-1" }));
    assert.equal(hasFocusSnapshot("blk-1"), false);
    assert.equal(isDetachedModule("blk-1"), true);
});

test("decideDockedFocusAction: magnify only for docked, unmagnified, present nodes", () => {
    assert.equal(decideDockedFocusAction(false, "node-1", null), "magnify");
    assert.equal(decideDockedFocusAction(false, "node-1", "node-other"), "magnify");
    assert.equal(decideDockedFocusAction(false, "node-1", "node-1"), "noop"); // idempotente
    assert.equal(decideDockedFocusAction(true, "node-1", null), "noop"); // detached lo maneja emain
    assert.equal(decideDockedFocusAction(false, null, null), "noop"); // no está en este tab
});

test("decideDockedFocusReleaseAction: unmagnify only when currently magnified", () => {
    assert.equal(decideDockedFocusReleaseAction(false, "node-1", "node-1"), "unmagnify");
    assert.equal(decideDockedFocusReleaseAction(false, "node-1", "node-other"), "noop");
    assert.equal(decideDockedFocusReleaseAction(false, "node-1", null), "noop");
    assert.equal(decideDockedFocusReleaseAction(true, "node-1", "node-1"), "noop");
    assert.equal(decideDockedFocusReleaseAction(false, null, "node-1"), "noop");
});

test("module.minimized delta and typed re-emit", () => {
    const model = SpatialModel.getInstance();
    detachModuleForTest("blk-1", "surf-1");
    const seen: [string, boolean][] = [];
    getSpatialBus().on("module.minimized", (p) => seen.push([p.moduleId, p.minimized]));
    model.handleWpsEvent(makeUpdateEvent({ type: "module.minimized", moduleid: "blk-1", payload: { minimized: true } as any }));
    assert.deepEqual(seen, [["blk-1", true]]);
    assert.equal(globalStore.get(model.spatialStateAtom).modules["blk-1"].isminimized, true);
    model.handleWpsEvent(makeUpdateEvent({ type: "module.minimized", moduleid: "blk-1", payload: { minimized: false } as any }));
    assert.equal(globalStore.get(model.spatialStateAtom).modules["blk-1"].isminimized, false);
});

test("applySpatialMenu appends items to a docked header menu", () => {
    const base: ContextMenuItem[] = [
        { label: "Magnify Block", click: () => {} },
        { type: "separator" },
        { label: "Close Block", click: () => {} },
    ];
    const menu = applySpatialMenu(base, "blk-docked");
    assert.deepEqual(
        menu.map(labelOf),
        ["Magnify Block", "|", "Close Block", "|", ...DockedBaseLabels, ...ProfileTailLabels]
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
        menu.map(labelOf),
        ["Copy BlockId", "|", ...DetachedBaseLabels, ...ProfileTailLabels]
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

test("buildProfileSubmenu: one item per profile, click selects", () => {
    const selected: string[] = [];
    const items = buildProfileSubmenu(["trabajo", "incident-response"], (name) => selected.push(name));
    assert.deepEqual(
        items.map((it) => it.label),
        ["trabajo", "incident-response"]
    );
    items[1].click();
    assert.deepEqual(selected, ["incident-response"]);
});

test("buildProfileSubmenu: empty or null list yields disabled '(sin perfiles)'", () => {
    assert.deepEqual(buildProfileSubmenu([], () => {}), [{ label: "(sin perfiles)", enabled: false }]);
    assert.deepEqual(buildProfileSubmenu(null, () => {}), [{ label: "(sin perfiles)", enabled: false }]);
});

test("spatial menu: load submenu built from the profile list, docked and detached", () => {
    let load = buildSpatialMenuItems("blk-docked", null, ["trabajo", "demo"]).find((it) => it.label === "Cargar perfil");
    assert.equal(load.type, "submenu");
    assert.deepEqual(
        load.submenu.map((it) => it.label),
        ["trabajo", "demo"]
    );

    detachModuleForTest("blk-1", "surf-1");
    load = buildSpatialMenuItems("blk-1").find((it) => it.label === "Cargar perfil");
    assert.deepEqual(load.submenu, [{ label: "(sin perfiles)", enabled: false }]);
});

test("spatial menu: save item opens SpatialSaveProfileModal", () => {
    const pushed: [string, any][] = [];
    const origPush = modalsModel.pushModal;
    modalsModel.pushModal = (displayName: string, props?: any) => pushed.push([displayName, props]);
    try {
        buildSpatialMenuItems("blk-docked").find((it) => it.label === "Guardar layout como perfil…").click();
    } finally {
        modalsModel.pushModal = origPush;
    }
    assert.deepEqual(pushed, [["SpatialSaveProfileModal", undefined]]);
});

test("saveProfileAs sends SpatialSaveProfileCommand with the entered name", async () => {
    const calls = installRpcRecorder();
    SpatialModel.getInstance().workspaceId = "ws-1";
    await saveProfileAs("trabajo");
    assert.deepEqual(calls, [["spatialsaveprofile", { name: "trabajo", workspaceid: "ws-1" }]]);
});

test("load submenu click sends SpatialLoadProfileCommand", async () => {
    const calls = installRpcRecorder();
    SpatialModel.getInstance().workspaceId = "ws-1";
    const load = buildSpatialMenuItems("blk-docked", null, ["trabajo"]).find((it) => it.label === "Cargar perfil");
    load.submenu[0].click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [["spatialloadprofile", { name: "trabajo", workspaceid: "ws-1" }]]);
});

test("applySpatialMenuAsync fetches the profile list when the menu opens", async () => {
    installRpcRecorder(["incident-response"]);
    const menu = await applySpatialMenuAsync([], "blk-docked");
    const load = menu.find((it) => it.label === "Cargar perfil");
    assert.deepEqual(
        load.submenu.map((it) => it.label),
        ["incident-response"]
    );
});
