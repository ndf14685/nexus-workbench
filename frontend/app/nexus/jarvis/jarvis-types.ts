// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Domain types and provider interfaces for the Jarvis Block (ADR-0005).
// This module has ZERO dependencies on UI, Wave internals, or AI providers.

export type JarvisActivityState =
    | "idle"
    | "listening"
    | "thinking"
    | "working"
    | "waiting-approval"
    | "speaking"
    | "success"
    | "error";

export type JarvisTaskState = "queued" | "running" | "waiting-approval" | "completed" | "cancelled" | "error";

export type JarvisTask = {
    id: string;
    state: JarvisTaskState;
    title: string;
    progress: number; // 0-100
    result?: string;
    error?: string;
    startedAt: number;
    endedAt?: number;
    approval?: JarvisApprovalRequest;
    resultSeen?: boolean;
};

export type JarvisApprovalRisk = "LOW" | "MEDIUM" | "HIGH";

export type JarvisApprovalRequest = {
    action: string; // exact command/action Jarvis wants to run
    risk: JarvisApprovalRisk;
    reason?: string;
};

// Context the Workbench pushes into Jarvis — prompts are never the only input.
// All fields optional: providers fill what they can, consumers handle nulls.
export type WorkbenchContext = {
    host?: string;
    terminalBlockId?: string;
    workingDirectory?: string;
    repository?: string;
    branch?: string;
    project?: string;
    workspace?: string;
    environment?: string;
    selectedFile?: string;
    selectedText?: string;
};

export type JarvisEventMap = {
    "jarvis.startListening": undefined;
    "jarvis.stopListening": undefined;
    "jarvis.taskCreated": JarvisTask;
    "jarvis.taskUpdated": JarvisTask;
    "jarvis.taskCompleted": JarvisTask;
    "jarvis.taskCancelled": JarvisTask;
    "jarvis.contextChanged": WorkbenchContext;
    "jarvis.resultReady": JarvisTask;
    "jarvis.error": { message: string; taskId?: string };
};

export type JarvisEventName = keyof JarvisEventMap;

// The runtime is the ONLY door to intelligence. The mock implementation ships
// first; OpenClaw/Jarvis Runtime replaces it behind this same interface.
export interface JarvisRuntime {
    submitPrompt(prompt: string, context: WorkbenchContext): Promise<string>; // returns taskId
    cancelTask(taskId: string): void;
    approveTask(taskId: string, editedAction?: string): void;
    rejectTask(taskId: string): void;
}

// Voice is interface-only for the MVP (push-to-talk drives it; wake word later).
export interface VoiceProvider {
    startListening(): Promise<void>;
    stopListening(): Promise<void>;
    transcribe(): Promise<string>;
}
