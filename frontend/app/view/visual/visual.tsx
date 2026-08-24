// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// El bloque HMI. Es un bloque como cualquier otro: se mueve, se redimensiona,
// se manda a otro monitor y el layout lo restaura. Lo único propio es el
// <video> y la barra de estado.

import { useAtomValue } from "jotai";
import { memo, useEffect, useRef } from "react";
import type { AIVisionMode } from "@/app/nexus/visual/visual-types";
import { sourceLabel } from "@/app/nexus/visual/visual-types";
import { VisualSourceViewModel, type VisualState } from "./visual-model";

const AIVisionLabels: Record<AIVisionMode, string> = {
    off: "OFF",
    on_demand: "ON DEMAND",
    changes: "CHANGES",
};

// El indicador de observación por IA es deliberadamente visible: que la IA pueda
// mirar nunca puede ser un estado silencioso (§11).
const AIVisionStyles: Record<AIVisionMode, string> = {
    off: "text-secondary",
    on_demand: "text-accent",
    changes: "text-warning",
};

const OfflinePanel = memo(
    ({ model, state }: { model: VisualSourceViewModel; state: VisualState }) => {
        const sources = useAtomValue(model.sourcesAtom);
        const sourceId = useAtomValue(model.sourceIdAtom);
        return (
            <div className="flex flex-col items-center justify-center gap-3 h-full w-full text-center px-6">
                <i className="fa fa-solid fa-video-slash text-4xl text-secondary" />
                <div className="text-lg text-error font-medium">{state.code ?? "SOURCE OFFLINE"}</div>
                <div className="text-sm text-secondary max-w-md">{model.statusMessage(state)}</div>
                <div className="flex gap-2 mt-2">
                    <button
                        type="button"
                        className="px-3 py-1.5 rounded border border-border text-sm hover:bg-hoverbg cursor-pointer"
                        onClick={() => model.reconnect()}
                    >
                        <i className="fa fa-solid fa-rotate-right mr-1.5" />
                        Reconnect
                    </button>
                    {sources.length > 1 ? (
                        <select
                            className="px-2 py-1.5 rounded border border-border bg-transparent text-sm cursor-pointer"
                            value={sourceId}
                            onChange={(e) => void model.selectSource(e.target.value)}
                        >
                            {sources.map((src) => (
                                <option key={src.id} value={src.id}>
                                    {sourceLabel(src)}
                                </option>
                            ))}
                        </select>
                    ) : null}
                </div>
                {sources.length === 0 ? (
                    <div className="text-xs text-secondary mt-2 max-w-md">
                        No hay fuentes visuales configuradas. Agregá una en Settings, clave{" "}
                        <code>nexus:visualsources</code>.
                    </div>
                ) : null}
            </div>
        );
    }
);
OfflinePanel.displayName = "OfflinePanel";

const StatusBar = memo(({ model }: { model: VisualSourceViewModel }) => {
    const aiVision = useAtomValue(model.aiVisionAtom);
    const state = useAtomValue(model.stateAtom);
    const sources = useAtomValue(model.sourcesAtom);
    const sourceId = useAtomValue(model.sourceIdAtom);

    return (
        <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-t border-border text-xxs shrink-0">
            <div className="flex items-center gap-2">
                <span className="text-secondary">Yoshi Vision:</span>
                <select
                    className={`bg-transparent border-none outline-none cursor-pointer ${AIVisionStyles[aiVision]}`}
                    value={aiVision}
                    onChange={(e) => void model.setAIVision(e.target.value as AIVisionMode)}
                    title="Ver la señal y dejar que la IA la observe son permisos distintos"
                >
                    {(Object.keys(AIVisionLabels) as AIVisionMode[]).map((mode) => (
                        <option key={mode} value={mode}>
                            {AIVisionLabels[mode]}
                        </option>
                    ))}
                </select>
                {aiVision !== "off" ? (
                    <i className={`fa fa-solid fa-eye ${AIVisionStyles[aiVision]}`} title="La IA puede observar esta fuente" />
                ) : null}
            </div>
            <div className="flex items-center gap-3 text-secondary">
                {sources.length > 1 ? (
                    <select
                        className="bg-transparent border-none outline-none cursor-pointer text-secondary"
                        value={sourceId}
                        onChange={(e) => void model.selectSource(e.target.value)}
                    >
                        {sources.map((src) => (
                            <option key={src.id} value={src.id}>
                                {sourceLabel(src)}
                            </option>
                        ))}
                    </select>
                ) : null}
                {state.status === "live" && state.width ? (
                    <span>
                        {state.width}x{state.height}
                        {state.fps ? ` ${Math.round(state.fps)}fps` : ""}
                    </span>
                ) : null}
            </div>
        </div>
    );
});
StatusBar.displayName = "StatusBar";

const VisualSourceView = memo(({ model }: ViewComponentProps<VisualSourceViewModel>) => {
    const state = useAtomValue(model.stateAtom);
    const sourceId = useAtomValue(model.sourceIdAtom);
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        model.videoRef = videoRef;
        model.installDeviceWatcher();
        void model.start();
        return () => {
            // Al desmontar (cerrar el bloque, cambiar de tab, mover de ventana)
            // el device se suelta. Sin esto quedan tracks vivos y la próxima
            // apertura da DEVICE_BUSY contra nosotros mismos.
            model.removeDeviceWatcher();
            model.stopStream();
        };
        // Cambiar de fuente reabre el stream con el device nuevo.
    }, [model, sourceId]);

    // Reatar el stream cuando React reemplaza el elemento (por ejemplo al mover
    // el bloque a otra ventana: el nodo se recrea, el MediaStream sobrevive).
    useEffect(() => {
        if (state.status === "live") {
            model.attachStream();
        }
    }, [model, state.status]);

    return (
        <div className="flex flex-col h-full w-full overflow-hidden bg-black">
            <div className="flex-1 min-h-0 relative">
                <video
                    ref={videoRef}
                    className={`w-full h-full object-contain ${state.status === "live" ? "" : "hidden"}`}
                    autoPlay
                    playsInline
                    muted
                />
                {state.status === "connecting" ? (
                    <div className="absolute inset-0 flex items-center justify-center text-secondary">
                        <i className="fa fa-solid fa-spinner fa-spin text-2xl" />
                    </div>
                ) : null}
                {state.status === "offline" || state.status === "error" ? (
                    <div className="absolute inset-0">
                        <OfflinePanel model={model} state={state} />
                    </div>
                ) : null}
            </div>
            <StatusBar model={model} />
        </div>
    );
});
VisualSourceView.displayName = "VisualSourceView";

export { VisualSourceView };
