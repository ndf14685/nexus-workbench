// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { WorkbenchContext } from "@/app/nexus/jarvis/jarvis-types";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import * as jotai from "jotai";
import { getSpatialBus, MonitorInfo, SpatialBus, SpatialEventName } from "./spatial-bus";

function parsePayload(payload: unknown): any {
    if (payload == null) {
        return null;
    }
    // json.RawMessage arrives inline as an object, but the generated TS type says string
    if (typeof payload !== "string") {
        return payload;
    }
    try {
        return JSON.parse(payload);
    } catch (e) {
        console.error("spatial-model: invalid event payload", e);
        return null;
    }
}

function makeModuleStub(moduleId: string): ModuleInstance {
    return {
        id: moduleId,
        type: "",
        lifecyclestate: "detached",
        currentsurfaceid: "",
        createdts: 0,
        updatedts: 0,
    };
}

export class SpatialModel {
    private static instance: SpatialModel = null;

    bus: SpatialBus;
    workspaceId: string = null;
    unsubFn: () => void = null;

    spatialStateAtom: jotai.PrimitiveAtom<SpatialState> = jotai.atom(null) as jotai.PrimitiveAtom<SpatialState>;
    detachedModuleIdsAtom!: jotai.Atom<Set<string>>;

    private constructor() {
        this.bus = getSpatialBus();
        this.detachedModuleIdsAtom = jotai.atom((get) => {
            const st = get(this.spatialStateAtom);
            const ids = new Set<string>();
            if (st?.modules == null) {
                return ids;
            }
            for (const [moduleId, mod] of Object.entries(st.modules)) {
                if (mod?.isdetached) {
                    ids.add(moduleId);
                }
            }
            return ids;
        });
    }

    static getInstance(): SpatialModel {
        if (!SpatialModel.instance) {
            SpatialModel.instance = new SpatialModel();
        }
        return SpatialModel.instance;
    }

    static resetInstance(): void {
        SpatialModel.instance = null;
    }

    start(workspaceId: string): void {
        if (this.unsubFn != null) {
            if (this.workspaceId === workspaceId) {
                return;
            }
            this.stop();
        }
        this.workspaceId = workspaceId;
        this.unsubFn = waveEventSubscribeSingle({
            eventType: "spatial:update",
            scope: `workspace:${workspaceId}`,
            handler: (event) => this.handleWpsEvent(event),
        });
    }

    stop(): void {
        this.unsubFn?.();
        this.unsubFn = null;
        this.workspaceId = null;
    }

    // WPS entry point (public so tests and bridges can inject events)
    handleWpsEvent(event: WaveEvent): void {
        const data = event?.data as SpatialEventData;
        if (data?.type == null) {
            return;
        }
        const payload = parsePayload(data.payload);
        this.applyEventToState(data, payload);
        this.reemit(data, payload);
    }

    // Interim delta application: the authoritative reload via
    // SpatialGetStateCommand arrives with the engine RPCs (plan task 4).
    applyEventToState(data: SpatialEventData, payload: any): void {
        if (data.type === "module.detached") {
            const surface = payload as Surface;
            const surfaceId = data.surfaceid ?? surface?.id ?? "";
            const st = this.cloneState(data.workspaceid);
            st.modules[data.moduleid] = {
                ...(st.modules[data.moduleid] ?? makeModuleStub(data.moduleid)),
                lifecyclestate: "detached",
                currentsurfaceid: surfaceId,
                isdetached: true,
            };
            if (surface?.id) {
                st.surfaces[surface.id] = surface;
            }
            globalStore.set(this.spatialStateAtom, st);
            return;
        }
        if (data.type === "module.attached") {
            const cur = globalStore.get(this.spatialStateAtom);
            if (cur?.modules?.[data.moduleid] == null) {
                return;
            }
            const st = this.cloneState(data.workspaceid);
            const surfaceId = st.modules[data.moduleid].currentsurfaceid;
            delete st.modules[data.moduleid];
            if (surfaceId) {
                delete st.surfaces[surfaceId];
            }
            globalStore.set(this.spatialStateAtom, st);
        }
    }

    cloneState(workspaceId: string): SpatialState {
        const cur = globalStore.get(this.spatialStateAtom);
        return {
            oid: cur?.oid ?? "",
            version: cur?.version ?? 0,
            schemaversion: cur?.schemaversion ?? 1,
            workspaceid: cur?.workspaceid ?? workspaceId,
            createdts: cur?.createdts ?? 0,
            updatedts: cur?.updatedts ?? 0,
            ...cur,
            modules: { ...cur?.modules },
            surfaces: { ...cur?.surfaces },
        };
    }

    reemit(data: SpatialEventData, payload: any): void {
        const eventType = data.type as SpatialEventName;
        switch (eventType) {
            case "module.created":
            case "module.closed":
            case "module.attached":
            case "module.focused":
            case "module.focusReleased":
                this.bus.emit(eventType, { moduleId: data.moduleid });
                break;
            case "module.detached":
                this.bus.emit(eventType, { moduleId: data.moduleid, surface: payload as Surface });
                break;
            case "module.moved":
            case "module.resized":
                this.bus.emit(eventType, { moduleId: data.moduleid, placement: payload as SpatialPlacement });
                break;
            case "module.surfaceChanged":
                this.bus.emit(eventType, { moduleId: data.moduleid, from: payload?.from, to: payload?.to });
                break;
            case "surface.created":
                this.bus.emit(eventType, { surface: payload as Surface });
                break;
            case "surface.closed":
                this.bus.emit(eventType, { surfaceId: data.surfaceid });
                break;
            case "monitor.connected":
                this.bus.emit(eventType, { monitor: payload as MonitorInfo });
                break;
            case "monitor.disconnected":
                this.bus.emit(eventType, { monitorId: data.monitorid });
                break;
            case "workspace.layoutSaved":
            case "workspace.layoutRestored":
                this.bus.emit(eventType, { profile: payload?.profile });
                break;
            case "context.changed":
                this.bus.emit(eventType, { context: payload as WorkbenchContext });
                break;
            case "jarvis.commandReceived":
                this.bus.emit(eventType, { command: payload?.command, args: payload?.args });
                break;
            default:
                console.warn(`spatial-model: unknown spatial event type ${data.type}`);
        }
    }
}
