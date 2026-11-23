// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

const MaxAudioBytes = 25 * 1024 * 1024;
const KeyNames = ["NEXUS_OPENAI_API_KEY", "OPENAI_API_KEY"] as const;

type TranscriptionRequest = {
    audioBase64?: unknown;
    mimeType?: unknown;
};

function readKeyFromEnvFile(filePath: string): string | null {
    try {
        const contents = fs.readFileSync(filePath, "utf8");
        for (const keyName of KeyNames) {
            const match = contents.match(new RegExp(`^\\s*${keyName}\\s*=\\s*([^\\r\\n#]+)\\s*$`, "m"));
            const key = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
            if (key) return key;
        }
        return null;
    } catch {
        return null;
    }
}

function getOpenAIKey(): string | null {
    for (const keyName of KeyNames) {
        const processKey = process.env[keyName]?.trim();
        if (processKey) return processKey;
    }

    // The user-data location is for installed builds; appPath supports local development.
    for (const envPath of [path.join(app.getPath("userData"), ".env.local"), path.join(app.getAppPath(), ".env.local")]) {
        const key = readKeyFromEnvFile(envPath);
        if (key) return key;
    }
    return null;
}

function extensionForMime(mimeType: string): string {
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    return "webm";
}

export function initDictationIpcHandlers() {
    ipcMain.handle("nexus-transcribe-audio", async (_event, request: TranscriptionRequest) => {
        if (typeof request?.audioBase64 !== "string" || typeof request?.mimeType !== "string") {
            throw new Error("Audio de dictado inválido.");
        }
        if (!request.mimeType.startsWith("audio/")) {
            throw new Error("El dictado requiere un archivo de audio.");
        }

        const audio = Buffer.from(request.audioBase64, "base64");
        if (audio.length === 0 || audio.length > MaxAudioBytes) {
            throw new Error("El audio debe tener entre 1 byte y 25 MB.");
        }

        const apiKey = getOpenAIKey();
        if (!apiKey) {
            throw new Error("Falta NEXUS_OPENAI_API_KEY (o OPENAI_API_KEY) en .env.local.");
        }

        const form = new FormData();
        form.append("model", "gpt-4o-mini-transcribe");
        form.append("file", new Blob([audio], { type: request.mimeType }), `dictation.${extensionForMime(request.mimeType)}`);
        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
        });
        const payload = (await response.json().catch(() => ({}))) as { text?: unknown; error?: { message?: unknown } };
        if (!response.ok) {
            const detail = typeof payload.error?.message === "string" ? payload.error.message : `HTTP ${response.status}`;
            throw new Error(`No se pudo transcribir el audio: ${detail}`);
        }
        if (typeof payload.text !== "string") {
            throw new Error("La transcripción no devolvió texto.");
        }
        return { text: payload.text };
    });
}
