// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { createRef } from "react";
import type { LayoutNodeAdditionalProps, NodeModel } from "@/layout/lib/types";

// Synthetic NodeModel for a detached window (ADR-0006 §7): there is no
// LayoutModel in a surface renderer, so the single module gets a fixed
// always-focused, never-magnified node. onClose = Pop In (the engine closes
// the window via surface.closed). toggleMagnify = maximize/unmaximize de la
// PROPIA ventana vía IPC de preload (spatial-toggle-maximize): decisión Task
// 10 — es chrome de ventana puro, sin estado del engine ni snapshot (eso es
// Focus); import dinámico de getApi para no exigir Electron en vitest.
export function makeSurfaceNodeModel(moduleId: string): NodeModel {
    return {
        additionalProps: atom({} as LayoutNodeAdditionalProps),
        innerRect: atom(null) as ReturnType<typeof atom<React.CSSProperties>>,
        blockNum: atom(1),
        numLeafs: atom(1),
        nodeId: moduleId,
        blockId: moduleId,
        addEphemeralNodeToLayout: () => {},
        animationTimeS: atom(0),
        isResizing: atom(false),
        isFocused: atom(true),
        isMagnified: atom(false),
        anyMagnified: atom(false),
        isEphemeral: atom(false),
        ready: atom(true),
        disablePointerEvents: atom(false),
        toggleMagnify: () => {
            fireAndForget(async () => (await import("@/app/store/global")).getApi().spatialToggleMaximize());
        },
        focusNode: () => {},
        onClose: () => {
            fireAndForget(async () => RpcApi.SpatialAttachCommand(TabRpcClient, { moduleid: moduleId }));
        },
        displayContainerRef: createRef<HTMLDivElement>(),
    };
}
