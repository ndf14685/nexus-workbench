// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { WorkbenchContext } from "@/app/nexus/jarvis/jarvis-types";

export interface SpatialEventMap {
    "module.created": { moduleId: string };
    "module.closed": { moduleId: string };
    "module.detached": { moduleId: string; surface: Surface };
    "module.attached": { moduleId: string };
    "module.moved": { moduleId: string; placement: SpatialPlacement };
    "module.resized": { moduleId: string; placement: SpatialPlacement };
    "module.focused": { moduleId: string };
    "module.focusReleased": { moduleId: string };
    // Extensión al contrato §2 (Task 10): estado minimizado de un detached
    "module.minimized": { moduleId: string; minimized: boolean };
    "module.surfaceChanged": { moduleId: string; from: string; to: string };
    "surface.created": { surface: Surface };
    "surface.closed": { surfaceId: string };
    "monitor.connected": { monitor: MonitorInfo };
    "monitor.disconnected": { monitorId: string };
    "workspace.layoutSaved": { profile: string };
    "workspace.layoutRestored": { profile: string };
    "context.changed": { context: WorkbenchContext };
    "jarvis.commandReceived": { command: string; args: unknown };
}

export type SpatialEventName = keyof SpatialEventMap;

type Handler<E extends SpatialEventName> = (payload: SpatialEventMap[E]) => void;

// Typed event bus fed exclusively by the WPS "spatial:update" subscription
// (never by polling). UI, model and future renderers communicate only through
// events, never by importing each other's internals.
export class SpatialBus {
    private handlers: Map<SpatialEventName, Set<Handler<any>>> = new Map();

    on<E extends SpatialEventName>(event: E, handler: Handler<E>): () => void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event).add(handler);
        return () => this.off(event, handler);
    }

    off<E extends SpatialEventName>(event: E, handler: Handler<E>): void {
        this.handlers.get(event)?.delete(handler);
    }

    emit<E extends SpatialEventName>(event: E, payload: SpatialEventMap[E]): void {
        for (const handler of this.handlers.get(event) ?? []) {
            try {
                handler(payload);
            } catch (e) {
                console.error(`spatial-bus: handler error on ${event}`, e);
            }
        }
    }

    clear(): void {
        this.handlers.clear();
    }
}

let spatialBusInstance: SpatialBus = null;

export function getSpatialBus(): SpatialBus {
    if (spatialBusInstance == null) {
        spatialBusInstance = new SpatialBus();
    }
    return spatialBusInstance;
}

export function resetSpatialBus(): void {
    spatialBusInstance = null;
}
