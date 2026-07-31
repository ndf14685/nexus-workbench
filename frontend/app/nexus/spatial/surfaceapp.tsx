// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { Block } from "@/app/block/block";
import { ModalsRenderer } from "@/app/modals/modalsrenderer";
import { globalStore } from "@/app/store/jotaiStore";
import { getTabModelByTabId, TabModelContext } from "@/app/store/tab-model";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { ErrorBoundary } from "@/element/errorboundary";
import { CenteredDiv } from "@/element/quickelems";
import { Provider } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { makeSurfaceNodeModel } from "./surface-node-model";

type SurfaceAppProps = {
    opts: SpatialInitOpts;
    onFirstRender: () => void;
};

function SurfaceAppInner({ opts }: { opts: SpatialInitOpts }) {
    const nodeModel = useMemo(() => makeSurfaceNodeModel(opts.moduleId), [opts.moduleId]);
    return (
        <div className="w-full h-full flex flex-col bg-main-bg text-main-text p-[3px]">
            <ErrorBoundary fallback={<CenteredDiv>Error al montar el módulo</CenteredDiv>}>
                <Block key={opts.moduleId} nodeModel={nodeModel} preview={false} />
            </ErrorBoundary>
            <ModalsRenderer />
        </div>
    );
}

// Renders exactly one detached module. Provider set mirrors BuilderApp
// (jotai Provider + WaveEnv) plus the owning tab's TabModelContext so
// Block/BlockFrame resolve tab metadata; no LayoutModel is ever created here.
export function SurfaceApp({ opts, onFirstRender }: SurfaceAppProps) {
    const waveEnvRef = useRef(makeWaveEnvImpl());
    useEffect(() => {
        onFirstRender();
    }, []);

    return (
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={waveEnvRef.current}>
                <TabModelContext.Provider value={getTabModelByTabId(opts.tabId)}>
                    <SurfaceAppInner opts={opts} />
                </TabModelContext.Provider>
            </WaveEnvContext.Provider>
        </Provider>
    );
}
