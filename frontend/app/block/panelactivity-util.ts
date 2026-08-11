// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// =============================================================================
// Smart Activity / AI Context — pure helpers (Phase G)
// =============================================================================
//
// Dependency-light types + privacy helpers for the future AI activity-summary pipeline. Kept separate
// from panelactivity.ts (which touches the store / RPC) so the secret scrubber and clamp logic can be
// unit tested in isolation. See panelactivity.ts for the runtime pipeline and docs.

export const ActivitySource_Manual = "manual";
export const ActivitySource_AiPrefix = "ai:";

export const MaxActivityWords = 8;

// The internal prompt a summarizer SHOULD use (adapt to the provider). Describe the goal, not the tool.
export const ActivitySummaryPrompt =
    "Describe en máximo 8 palabras (idealmente 4-7) qué está intentando lograr el usuario en este panel. " +
    "Describe el OBJETIVO de trabajo, no la aplicación ni la herramienta. " +
    "No incluyas secretos, rutas completas ni comandos literales. " +
    "Responde únicamente con la descripción, sin comillas ni puntuación final.";

// Raw signals gathered from a panel. Today only existing block meta is used (no scrollback / no DOM
// scraping). Future signals (recentCommands, pageText) are declared so the shape is stable.
export type PanelContextSignal = {
    view: string;
    customTitle?: string;
    note?: string;
    connection?: string;
    cwd?: string;
    url?: string;
    recentCommands?: string[]; // future: bounded + sanitized
    pageText?: string; // future: bounded + sanitized
};

// A context that has passed through the secret scrubber. The nominal flag makes it hard to hand an
// un-sanitized context to a summarizer by accident.
export type SanitizedPanelContext = PanelContextSignal & { readonly __sanitized: true };

export type ActivitySummary = {
    text: string;
    updatedAt: number;
    source: string;
};

export interface ActivitySummarizer {
    // return a short (<= MaxActivityWords) description of the user's goal, or null if it can't.
    summarize(ctx: SanitizedPanelContext): Promise<string | null>;
    // optional: identifies the model, used to stamp frame:activity:source (e.g. "ai:llama3").
    modelName?: string;
}

// crude but conservative secret scrubbers. This runs on any string signal before it can leave the app.
const SecretLinePatterns: RegExp[] = [
    /(?:password|passwd|secret|token|apikey|api[_-]?key|access[_-]?key|private[_-]?key|authorization|bearer|cookie|session)\s*[:=]\s*\S+/gi,
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    /\b[A-Za-z0-9_-]*(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g, // common token prefixes
    /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long base64-ish blobs
];

export function scrubSecrets(input: string): string {
    if (input == null || input === "") {
        return input;
    }
    let out = input;
    for (const re of SecretLinePatterns) {
        out = out.replace(re, "[redacted]");
    }
    return out;
}

export function sanitizePanelContext(ctx: PanelContextSignal): SanitizedPanelContext {
    const scrubList = (arr?: string[]) => (arr == null ? undefined : arr.map(scrubSecrets));
    return {
        view: ctx.view,
        customTitle: scrubSecrets(ctx.customTitle),
        note: scrubSecrets(ctx.note),
        connection: ctx.connection, // connection name/host is an identifier, not a secret
        cwd: ctx.cwd,
        url: scrubSecrets(ctx.url),
        recentCommands: scrubList(ctx.recentCommands),
        pageText: scrubSecrets(ctx.pageText),
        __sanitized: true,
    };
}

// keep only the first N words and strip wrapping quotes / trailing punctuation a model might add.
export function clampSummary(text: string, maxWords = MaxActivityWords): string {
    if (text == null) {
        return "";
    }
    const cleaned = text
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/[.。]+$/g, "")
        .trim();
    const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
    return words.slice(0, maxWords).join(" ");
}
