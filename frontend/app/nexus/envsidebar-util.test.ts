// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import {
    clampSidebarWidth,
    colorForEnv,
    connStateForEnv,
    defaultIconForEnv,
    findEnvByConn,
    groupEnvironments,
    groupTitleForEnv,
    SidebarDefaultWidth,
    SidebarMaxWidth,
    SidebarMinWidth,
    toggleGroup,
} from "./envsidebar-util";

const catalog: NexusEnvType[] = [
    { id: "local-windows", name: "Local Windows", kind: "local", conn: "" },
    { id: "wsl-ubuntu", name: "WSL Ubuntu", kind: "wsl", conn: "wsl://Ubuntu" },
    { id: "rig3060", name: "rig3060", kind: "ssh", conn: "ndf@192.168.50.105", class: "lab" },
    { id: "nexusos", name: "NexusOS", kind: "ssh", conn: "nexusos", class: "lab" },
];

test("groupEnvironments derives groups from kind, not names", () => {
    const groups = groupEnvironments(catalog);
    assert.deepEqual(
        groups.map((g) => g.title),
        ["Local", "Servidores"]
    );
    assert.deepEqual(
        groups[0].envs.map((e) => e.id),
        ["local-windows", "wsl-ubuntu"]
    );
    assert.deepEqual(
        groups[1].envs.map((e) => e.id),
        ["rig3060", "nexusos"]
    );
});

test("groupEnvironments handles empty and null catalogs", () => {
    assert.deepEqual(groupEnvironments([]), []);
    assert.deepEqual(groupEnvironments(null), []);
    assert.deepEqual(groupEnvironments([{ id: null } as NexusEnvType]), []);
});

test("unknown kinds fall into Otros with a generic icon and do not break", () => {
    const weird = { id: "k8s-pod", name: "Pod", kind: "kubernetes" } as NexusEnvType;
    assert.equal(groupTitleForEnv(weird), "Otros");
    const groups = groupEnvironments([...catalog, weird]);
    assert.deepEqual(
        groups.map((g) => g.title),
        ["Local", "Servidores", "Otros"]
    );
    assert.equal(defaultIconForEnv(weird), "circle-nodes");
    assert.equal(colorForEnv(weird), "#8b949e");
});

test("findEnvByConn matches focused block connection to catalog (active env sync)", () => {
    assert.equal(findEnvByConn(catalog, "ndf@192.168.50.105")?.id, "rig3060");
    assert.equal(findEnvByConn(catalog, "")?.id, "local-windows");
    assert.equal(findEnvByConn(catalog, "unknown-host"), null);
    assert.equal(findEnvByConn(catalog, null), null);
    assert.equal(findEnvByConn(null, "x"), null);
});

test("connStateForEnv maps connection status to sidebar states", () => {
    const rig = catalog[2];
    assert.equal(connStateForEnv(rig, { status: "connected" } as ConnStatus), "connected");
    assert.equal(connStateForEnv(rig, { status: "connecting" } as ConnStatus), "connecting");
    assert.equal(connStateForEnv(rig, { status: "error" } as ConnStatus), "error");
    assert.equal(connStateForEnv(rig, { status: "disconnected" } as ConnStatus), "disconnected");
    assert.equal(connStateForEnv(rig, null), "disconnected");
    assert.equal(connStateForEnv(catalog[0], null), "none");
});

test("clampSidebarWidth persists within bounds and falls back to default", () => {
    assert.equal(clampSidebarWidth(240), 240);
    assert.equal(clampSidebarWidth(10), SidebarMinWidth);
    assert.equal(clampSidebarWidth(9999), SidebarMaxWidth);
    assert.equal(clampSidebarWidth(0), SidebarDefaultWidth);
    assert.equal(clampSidebarWidth(null), SidebarDefaultWidth);
    assert.equal(clampSidebarWidth(NaN), SidebarDefaultWidth);
});

test("toggleGroup expands and collapses groups persistably", () => {
    let collapsed: string[] = [];
    collapsed = toggleGroup(collapsed, "Servidores");
    assert.deepEqual(collapsed, ["Servidores"]);
    collapsed = toggleGroup(collapsed, "Local");
    assert.deepEqual(collapsed.sort(), ["Local", "Servidores"]);
    collapsed = toggleGroup(collapsed, "Servidores");
    assert.deepEqual(collapsed, ["Local"]);
    assert.deepEqual(toggleGroup(null, "X"), ["X"]);
});
