// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

export const TerminalDictationEvent = "nexus:terminal-dictation-toggle";

export function requestTerminalDictation(blockId: string) {
    window.dispatchEvent(new CustomEvent(TerminalDictationEvent, { detail: { blockId } }));
}

export async function audioBlobToBase64(blob: Blob): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el audio."));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
