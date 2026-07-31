// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// JarvisCore: singleton wiring of bus + store + runtime + voice + context.
// Jarvis is ONE presence in the Workbench: every Jarvis block renders the same
// core state, so tasks survive closing/reopening blocks.

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { JarvisBus } from "./jarvis-bus";
import { getJarvisBrainConfig, WorkbenchContextProvider } from "./jarvis-context";
import { HttpJarvisRuntime } from "./jarvis-runtime-http";
import { MockJarvisRuntime, MockVoiceProvider } from "./jarvis-runtime-mock";
import { deriveActivityState, JarvisTaskStore } from "./jarvis-store";
import {
    JarvisActivityState,
    JarvisConnectionState,
    JarvisRuntime,
    JarvisTask,
    VoiceProvider,
    WorkbenchContext,
} from "./jarvis-types";

export class JarvisCore {
    private static instance: JarvisCore = null;

    bus: JarvisBus;
    store: JarvisTaskStore;
    runtime: JarvisRuntime;
    voice: VoiceProvider;
    contextProvider: WorkbenchContextProvider;

    tasksAtom: jotai.PrimitiveAtom<JarvisTask[]> = jotai.atom([]);
    interactionAtom: jotai.PrimitiveAtom<JarvisActivityState | null> = jotai.atom(null) as jotai.PrimitiveAtom<JarvisActivityState | null>;
    transcriptAtom: jotai.PrimitiveAtom<string> = jotai.atom("");
    contextAtom: jotai.PrimitiveAtom<WorkbenchContext> = jotai.atom({}) as jotai.PrimitiveAtom<WorkbenchContext>;
    activityAtom!: jotai.Atom<JarvisActivityState>;
    connectionAtom!: jotai.PrimitiveAtom<JarvisConnectionState>;

    private constructor() {
        this.bus = new JarvisBus();
        this.store = new JarvisTaskStore(this.bus);
        // ADR-0005 swap point, resolved per ADR-0007: a configured brain URL
        // selects the real jarvisd adapter; otherwise the labeled mock preview.
        // Voice stays mock either way (real voice pipeline is HUD-side, M4).
        const brain = getJarvisBrainConfig();
        if (brain.url) {
            this.connectionAtom = jotai.atom<JarvisConnectionState>("disconnected");
            this.runtime = new HttpJarvisRuntime(this.store, this.bus, {
                baseUrl: brain.url,
                token: brain.token,
                onConnectionChange: (state) => globalStore.set(this.connectionAtom, state),
            });
        } else {
            this.connectionAtom = jotai.atom<JarvisConnectionState>("mock");
            this.runtime = new MockJarvisRuntime(this.store, this.bus);
        }
        this.voice = new MockVoiceProvider();
        this.contextProvider = new WorkbenchContextProvider(this.bus);

        this.activityAtom = jotai.atom((get) => deriveActivityState(get(this.tasksAtom), get(this.interactionAtom)));

        this.store.subscribe(() => {
            globalStore.set(this.tasksAtom, this.store.getTasks());
        });
        this.bus.on("jarvis.contextChanged", (ctx) => {
            globalStore.set(this.contextAtom, ctx);
        });
        this.contextProvider.start();
        globalStore.set(this.contextAtom, this.contextProvider.getContext());
    }

    static getInstance(): JarvisCore {
        if (!JarvisCore.instance) {
            JarvisCore.instance = new JarvisCore();
        }
        return JarvisCore.instance;
    }

    // Called from the Jarvis view's mount/unmount effect: runtimes that poll
    // (HttpJarvisRuntime) only do so while at least one block is visible.
    attachView(): void {
        this.runtime.attach?.();
    }

    detachView(): void {
        this.runtime.detach?.();
    }

    retryConnection(): void {
        if (this.runtime instanceof HttpJarvisRuntime) {
            this.runtime.retryNow();
        }
    }

    isListening(): boolean {
        return globalStore.get(this.interactionAtom) === "listening";
    }

    // Push-to-talk: first call starts listening, second call stops, transcribes
    // (mock) and submits to the runtime with fresh Workbench context.
    async pushToTalk(): Promise<void> {
        if (this.isListening()) {
            await this.voice.stopListening();
            this.bus.emit("jarvis.stopListening", undefined);
            globalStore.set(this.interactionAtom, "thinking");
            try {
                const transcript = await this.voice.transcribe();
                globalStore.set(this.transcriptAtom, transcript);
                await this.submit(transcript);
            } catch (e) {
                this.bus.emit("jarvis.error", { message: String(e) });
                globalStore.set(this.interactionAtom, null);
            }
            return;
        }
        await this.voice.startListening();
        this.bus.emit("jarvis.startListening", undefined);
        globalStore.set(this.interactionAtom, "listening");
    }

    async submit(prompt: string): Promise<void> {
        if (!prompt?.trim()) {
            globalStore.set(this.interactionAtom, null);
            return;
        }
        globalStore.set(this.interactionAtom, "thinking");
        const ctx = this.contextProvider.getContext();
        globalStore.set(this.contextAtom, ctx);
        try {
            await this.runtime.submitPrompt(prompt.trim(), ctx);
        } finally {
            // task states drive the ring from here on
            globalStore.set(this.interactionAtom, null);
        }
    }
}
