// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { JarvisEventMap, JarvisEventName } from "./jarvis-types";

type Handler<E extends JarvisEventName> = (payload: JarvisEventMap[E]) => void;

// Internal typed event bus. Deliberately tiny: UI, store, runtime and future
// integrations (OpenClaw, voice, governance) communicate ONLY through events,
// never by importing each other's internals.
export class JarvisBus {
    private handlers: Map<JarvisEventName, Set<Handler<any>>> = new Map();

    on<E extends JarvisEventName>(event: E, handler: Handler<E>): () => void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event).add(handler);
        return () => this.off(event, handler);
    }

    off<E extends JarvisEventName>(event: E, handler: Handler<E>): void {
        this.handlers.get(event)?.delete(handler);
    }

    emit<E extends JarvisEventName>(event: E, payload: JarvisEventMap[E]): void {
        for (const handler of this.handlers.get(event) ?? []) {
            try {
                handler(payload);
            } catch (e) {
                console.error(`jarvis-bus: handler error on ${event}`, e);
            }
        }
    }

    clear(): void {
        this.handlers.clear();
    }
}
