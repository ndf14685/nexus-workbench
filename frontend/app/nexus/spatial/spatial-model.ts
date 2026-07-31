// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { WorkbenchContext } from "@/app/nexus/jarvis/jarvis-types";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { getSpatialBus, SpatialBus, SpatialEventName } from "./spatial-bus";

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

// Guard predicate for layoutModel.cleanupOrphanedBlocks (CONTRACTS §6): a
// detached module is in tab.blockids but outside the layout tree on purpose.
// Must never break the layout, so any failure reads as "not detached".
export function isDetachedModule(blockId: string): boolean {
    try {
        const model = SpatialModel.getInstance();
        return globalStore.get(model.detachedModuleIdsAtom).has(blockId);
    } catch (e) {
        console.error("spatial-model: isDetachedModule failed", e);
        return false;
    }
}

// Decision helper for LayoutModel.handleBackendAction "delete" (R1): the
// engine's Detach queues a layout delete for the block being popped out, so
// that delete must only remove the tree node — never DeleteBlock — or the
// module (pty, scrollback, state) is destroyed mid-detach.
export function shouldPreserveBlockOnDelete(blockId: string): boolean {
    return isDetachedModule(blockId);
}

// Decisión pura del cableado bus→magnify (Task 10): el focus acoplado se
// materializa con magnify en el tab estático; detached lo materializa emain.
// Idempotente: ya magnificado → no-op.
export function decideDockedFocusAction(
    isDetached: boolean,
    nodeId: string,
    magnifiedNodeId: string
): "magnify" | "noop" {
    if (isDetached || nodeId == null) {
        return "noop";
    }
    return magnifiedNodeId === nodeId ? "noop" : "magnify";
}

export function decideDockedFocusReleaseAction(
    isDetached: boolean,
    nodeId: string,
    magnifiedNodeId: string
): "unmagnify" | "noop" {
    if (isDetached || nodeId == null) {
        return "noop";
    }
    return magnifiedNodeId === nodeId ? "unmagnify" : "noop";
}

// Visibilidad de "Restaurar posición anterior" (CONTRACTS §7)
export function hasFocusSnapshot(blockId: string): boolean {
    try {
        const st = globalStore.get(SpatialModel.getInstance().spatialStateAtom);
        return st?.focussnapshots?.[blockId] != null;
    } catch (e) {
        console.error("spatial-model: hasFocusSnapshot failed", e);
        return false;
    }
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
        this.refreshState();
    }

    // Carga autoritativa del estado (tras un reinicio los deltas no alcanzan:
    // los guards y la visibilidad del menú necesitan lo persistido). Un evento
    // que llegue durante el vuelo puede pisarse; el próximo delta lo corrige.
    refreshState(): void {
        const workspaceId = this.workspaceId;
        if (workspaceId == null) {
            return;
        }
        fireAndForget(async () => {
            const st = await RpcApi.SpatialGetStateCommand(TabRpcClient, { workspaceid: workspaceId });
            if (this.workspaceId !== workspaceId || st == null) {
                return;
            }
            globalStore.set(this.spatialStateAtom, st);
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
        if (data.type === "module.moved") {
            const cur = globalStore.get(this.spatialStateAtom);
            if (cur?.modules?.[data.moduleid] == null) {
                return;
            }
            const st = this.cloneState(data.workspaceid);
            const placement = payload as SpatialPlacement;
            st.modules[data.moduleid] = {
                ...st.modules[data.moduleid],
                ...(placement != null ? { placement } : {}),
                monitorid: data.monitorid ?? "",
            };
            globalStore.set(this.spatialStateAtom, st);
            return;
        }
        if (data.type === "module.attached" || data.type === "module.closed") {
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
            delete st.focussnapshots[data.moduleid];
            globalStore.set(this.spatialStateAtom, st);
            return;
        }
        if (data.type === "module.focused") {
            const st = this.cloneState(data.workspaceid);
            st.focussnapshots[data.moduleid] = (payload as FocusSnapshot) ?? { moduleid: data.moduleid, wasdetached: false, capturedts: 0 };
            if (st.modules[data.moduleid] != null) {
                st.modules[data.moduleid] = { ...st.modules[data.moduleid], isfocused: true };
            }
            globalStore.set(this.spatialStateAtom, st);
            return;
        }
        if (data.type === "module.focusReleased") {
            const st = this.cloneState(data.workspaceid);
            delete st.focussnapshots[data.moduleid];
            const mod = st.modules[data.moduleid];
            if (mod != null) {
                // espejo del engine: la entrada acoplada creada solo para el
                // focus vuelve a "default" y desaparece
                if (!mod.isdetached && !mod.isminimized) {
                    delete st.modules[data.moduleid];
                } else {
                    st.modules[data.moduleid] = { ...mod, isfocused: false };
                }
            }
            globalStore.set(this.spatialStateAtom, st);
            return;
        }
        if (data.type === "module.minimized") {
            const cur = globalStore.get(this.spatialStateAtom);
            if (cur?.modules?.[data.moduleid] == null) {
                return;
            }
            const st = this.cloneState(data.workspaceid);
            st.modules[data.moduleid] = { ...st.modules[data.moduleid], isminimized: payload?.minimized === true };
            globalStore.set(this.spatialStateAtom, st);
        }
    }

    getModuleMonitorId(moduleId: string): string {
        const st = globalStore.get(this.spatialStateAtom);
        return st?.modules?.[moduleId]?.monitorid ?? "";
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
            focussnapshots: { ...cur?.focussnapshots },
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
            case "module.minimized":
                this.bus.emit(eventType, { moduleId: data.moduleid, minimized: payload?.minimized === true });
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
