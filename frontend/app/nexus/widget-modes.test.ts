// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import {
    blockDefForMode,
    buildModeMenuItems,
    DangerLabelPrefix,
    modeMenuLabel,
    parseWidgetModes,
    WidgetModesMetaKey,
} from "./widget-modes";

function blockdefWith(modes: any): BlockDef {
    const meta: MetaType = {
        view: "term",
        controller: "cmd",
        cmd: "claude",
        "cmd:shell": true,
        "cmd:runonstart": true,
    };
    meta[WidgetModesMetaKey] = modes;
    return { meta };
}

const twoModes = [
    { label: "Claude Code", command: "claude" },
    { label: "Claude Code (permisos totales)", command: "claude --dangerously-skip-permissions", danger: true },
];

test("parseWidgetModes devuelve [] sin la clave o con valor no-array", () => {
    assert.deepEqual(parseWidgetModes({ meta: { view: "term" } }), []);
    assert.deepEqual(parseWidgetModes(blockdefWith(null)), []);
    assert.deepEqual(parseWidgetModes(blockdefWith("claude")), []);
    assert.deepEqual(parseWidgetModes(blockdefWith({ label: "x", command: "y" })), []);
});

test("parseWidgetModes descarta entradas inválidas y conserva danger", () => {
    const modes = parseWidgetModes(
        blockdefWith([
            { label: "ok", command: "claude" },
            { label: "sin comando" },
            { command: "sin label" },
            { label: "  ", command: "vacio" },
            { label: "vacio2", command: "   " },
            null,
            "texto",
            { label: "peligro", command: "codex --yolo", danger: true },
            { label: "no-peligro", command: "codex", danger: "true" },
        ])
    );
    assert.deepEqual(modes, [
        { label: "ok", command: "claude" },
        { label: "peligro", command: "codex --yolo", danger: true },
        { label: "no-peligro", command: "codex" },
    ]);
});

test("modeMenuLabel marca los modos danger con prefijo", () => {
    assert.equal(modeMenuLabel({ label: "Codex", command: "codex" }), "Codex");
    assert.equal(modeMenuLabel({ label: "Codex", command: "codex --yolo", danger: true }), DangerLabelPrefix + "Codex");
});

test("blockDefForMode sobreescribe cmd y saca la clave de modos", () => {
    const base = blockdefWith(twoModes);
    const out = blockDefForMode(base, twoModes[1]);
    assert.equal(out.meta["cmd"], "claude --dangerously-skip-permissions");
    assert.equal(out.meta[WidgetModesMetaKey], undefined);
    assert.equal(out.meta["view"], "term");
    assert.equal(out.meta["controller"], "cmd");
    assert.equal(out.meta["cmd:runonstart"], true);
    // el blockdef original no se muta
    assert.equal(base.meta["cmd"], "claude");
    assert.deepEqual(base.meta[WidgetModesMetaKey], twoModes);
});

test("buildModeMenuItems devuelve [] con 0 o 1 modo (comportamiento normal)", () => {
    assert.deepEqual(
        buildModeMenuItems({ meta: { view: "term", cmd: "claude" } }, () => {}),
        []
    );
    assert.deepEqual(
        buildModeMenuItems(blockdefWith([{ label: "Claude Code", command: "claude" }]), () => {}),
        []
    );
});

test("buildModeMenuItems arma un item por modo y pasa el blockdef del modo elegido", () => {
    const selected: string[] = [];
    const items = buildModeMenuItems(blockdefWith(twoModes), (bd, mode) => {
        selected.push(`${mode.label}|${bd.meta["cmd"]}`);
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].label, "Claude Code");
    assert.equal(items[1].label, DangerLabelPrefix + "Claude Code (permisos totales)");
    items[1].click();
    items[0].click();
    assert.deepEqual(selected, [
        "Claude Code (permisos totales)|claude --dangerously-skip-permissions",
        "Claude Code|claude",
    ]);
});
