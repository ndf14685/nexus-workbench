// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import { findNodeByBlockId, newLayoutNode, walkNodes } from "../lib/layoutNode";
import { deleteNodeByBlockId, pruneMissingBlockNodes } from "../lib/layoutTree";
import { FlexDirection, LayoutNode } from "../lib/types";
import { newLayoutTreeState } from "./model";

function leaf(blockId: string): LayoutNode {
    return newLayoutNode(undefined, undefined, undefined, { blockId });
}

function collectBlockIds(rootNode: LayoutNode): string[] {
    const blockIds: string[] = [];
    walkNodes(rootNode, (node) => {
        if (node.data?.blockId) blockIds.push(node.data.blockId);
    });
    return blockIds;
}

test("findNodeByBlockId - finds nested leaf, returns undefined when missing", () => {
    const target = leaf("target");
    const root = newLayoutNode(FlexDirection.Row, undefined, [
        newLayoutNode(FlexDirection.Column, undefined, [leaf("a"), target]),
        leaf("b"),
    ]);
    assert(findNodeByBlockId(root, "target") === target, "should find the nested leaf node");
    assert(findNodeByBlockId(root, "nope") === undefined, "should return undefined for a missing blockId");
    assert(findNodeByBlockId(undefined, "target") === undefined, "should tolerate an undefined root");
});

test("deleteNodeByBlockId - removes leaf without needing rendered leafs", () => {
    const treeState = newLayoutTreeState(
        newLayoutNode(FlexDirection.Row, undefined, [
            newLayoutNode(FlexDirection.Column, undefined, [leaf("a"), leaf("ghost")]),
            leaf("b"),
        ])
    );
    assert(deleteNodeByBlockId(treeState, "ghost"), "should report the node as deleted");
    assert(!findNodeByBlockId(treeState.rootNode, "ghost"), "ghost should be gone from the tree");
    const remaining = collectBlockIds(treeState.rootNode);
    assert(remaining.length === 2 && remaining.includes("a") && remaining.includes("b"), "live leaves should survive");
    assert(!deleteNodeByBlockId(treeState, "ghost"), "deleting a missing block should return false");
});

test("deleteNodeByBlockId - collapses parent left empty and clears magnify", () => {
    const ghost = leaf("ghost");
    const ghostCol = newLayoutNode(FlexDirection.Column, undefined, [ghost]);
    const treeState = newLayoutTreeState(newLayoutNode(FlexDirection.Row, undefined, [ghostCol, leaf("a"), leaf("b")]));
    treeState.magnifiedNodeId = ghost.id;
    assert(deleteNodeByBlockId(treeState, "ghost"), "should delete the sole child of the column");
    assert(treeState.magnifiedNodeId == null, "magnified node id should be cleared");
    let emptyParents = 0;
    walkNodes(treeState.rootNode, (node) => {
        if (node.children?.length === 0) emptyParents++;
    });
    assert(emptyParents === 0, "no empty intermediate nodes should remain");
    assert(collectBlockIds(treeState.rootNode).length === 2, "both live leaves should remain");
});

test("pruneMissingBlockNodes - removes every node whose block no longer exists", () => {
    // replica de la forma del bug real: una hoja fantasma y una columna con dos
    // fantasmas colgadas del root, mezcladas con columnas vivas
    const treeState = newLayoutTreeState(
        newLayoutNode(FlexDirection.Row, undefined, [
            newLayoutNode(FlexDirection.Column, undefined, [leaf("live1"), leaf("live2")]),
            leaf("ghost1"),
            newLayoutNode(FlexDirection.Column, undefined, [leaf("ghost2"), leaf("ghost3")]),
            newLayoutNode(FlexDirection.Column, undefined, [leaf("live3"), leaf("live4"), leaf("live5")]),
        ])
    );
    const valid = new Set(["live1", "live2", "live3", "live4", "live5"]);
    const removed = pruneMissingBlockNodes(treeState, valid);
    assert(removed.length === 3, "should remove the three ghost blocks");
    const remaining = collectBlockIds(treeState.rootNode);
    assert(remaining.length === 5, "the five live leaves should remain");
    for (const blockId of valid) {
        assert(remaining.includes(blockId), `live block ${blockId} should survive the prune`);
    }
    let emptyParents = 0;
    walkNodes(treeState.rootNode, (node) => {
        if (node.children?.length === 0) emptyParents++;
    });
    assert(emptyParents === 0, "no empty intermediate nodes should remain after pruning");
});

test("pruneMissingBlockNodes - noop when everything is valid", () => {
    const treeState = newLayoutTreeState(newLayoutNode(FlexDirection.Row, undefined, [leaf("a"), leaf("b")]));
    const removed = pruneMissingBlockNodes(treeState, new Set(["a", "b"]));
    assert(removed.length === 0, "nothing should be removed");
    assert(collectBlockIds(treeState.rootNode).length === 2, "tree should be untouched");
});

test("pruneMissingBlockNodes - clears the tree when every block is gone", () => {
    const treeState = newLayoutTreeState(newLayoutNode(FlexDirection.Row, undefined, [leaf("g1"), leaf("g2")]));
    const removed = pruneMissingBlockNodes(treeState, new Set<string>());
    assert(removed.length === 2, "both ghosts should be removed");
    assert(treeState.rootNode == null, "root node should be cleared when nothing remains");
});
