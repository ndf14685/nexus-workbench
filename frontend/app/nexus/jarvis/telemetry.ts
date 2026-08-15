// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

export type JarvisTelemetryEvent =
    | "jarvis.invoke"
    | "jarvis.context.capture"
    | "jarvis.intent.resolve"
    | "jarvis.handoff"
    | "jarvis.mission.create"
    | "jarvis.mission.adopt"
    | "jarvis.mission.complete"
    | "jarvis.user_attention.required"
    | "jarvis.away_digest"
    | "jarvis.park"
    | "jarvis.restore";

interface JarvisLogEntry {
    ts: number;
    event: JarvisTelemetryEvent;
    data: Record<string, unknown>;
}

const MaxBufferedEntries = 500;
const buffer: JarvisLogEntry[] = [];

// solo metadata liviana: acá jamás entra texto de usuario, tokens ni output
export function jarvisLog(event: JarvisTelemetryEvent, data: Record<string, unknown> = {}) {
    const entry: JarvisLogEntry = { ts: Date.now(), event, data };
    buffer.push(entry);
    if (buffer.length > MaxBufferedEntries) {
        buffer.shift();
    }
    console.log(`[jarvis] ${event}`, data);
}

export function getJarvisLog(): JarvisLogEntry[] {
    return [...buffer];
}
