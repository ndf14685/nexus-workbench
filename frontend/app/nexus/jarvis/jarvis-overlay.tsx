// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { Modal } from "@/app/modals/modal";
import { modalsModel } from "@/app/store/modalmodel";
import { useEffect, useRef, useState } from "react";
import { getBrainConfig, saveBrainConfig } from "./brain-config";
import { postIntent } from "./brain-client";
import { captureFocusedContext, describeContext, type JarvisContextModule } from "./context";
import { listParked, matchParkIntent, parkBlock, restorePark, closeParked, type ParkedEntry } from "./parking";
import { jarvisLog } from "./telemetry";

interface Turn {
    who: "user" | "jarvis";
    text: string;
}

function BrainConfigForm({ onSaved }: { onSaved: () => void }) {
    const [url, setUrl] = useState("http://192.168.50.105:8770");
    const [token, setToken] = useState("");
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        try {
            await saveBrainConfig(url.trim(), token.trim());
            onSaved();
        } finally {
            setSaving(false);
        }
    };
    return (
        <div className="px-4 py-3 flex flex-col gap-2">
            <div className="text-sm text-secondary">Configurar la conexión al cerebro Jarvis (una sola vez):</div>
            <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="URL del cerebro (http://host:8770)"
                className="bg-panel px-3 py-2 rounded border border-border outline-none text-sm"
            />
            <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                placeholder="Token (NEXUS_BRAIN_TOKEN)"
                className="bg-panel px-3 py-2 rounded border border-border outline-none text-sm"
            />
            <button
                onClick={() => void save()}
                disabled={saving || !url.trim() || !token.trim()}
                className="self-end bg-accent/80 text-primary rounded hover:bg-accent transition-colors cursor-pointer px-4 py-1.5 text-sm disabled:opacity-50"
            >
                Guardar
            </button>
        </div>
    );
}

export function JarvisOverlay() {
    const [input, setInput] = useState("");
    const [turns, setTurns] = useState<Turn[]>([]);
    const [busy, setBusy] = useState(false);
    const [context, setContext] = useState<JarvisContextModule>({ kind: "empty" });
    const [configured, setConfigured] = useState<boolean>(null);
    const [parked, setParked] = useState<ParkedEntry[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const refreshParked = () => void listParked().then(setParked).catch(() => setParked([]));

    useEffect(() => {
        jarvisLog("jarvis.invoke", { source: "overlay" });
        void getBrainConfig().then((cfg) => setConfigured(cfg.configured || !!cfg.token));
        void captureFocusedContext().then((ctx) => {
            setContext(ctx);
            jarvisLog("jarvis.context.capture", { kind: ctx.kind });
        });
        refreshParked();
    }, []);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [turns]);

    const submit = async () => {
        const text = input.trim();
        if (!text || busy) {
            return;
        }
        setInput("");
        setTurns((prev) => [...prev, { who: "user", text }]);
        setBusy(true);
        if (matchParkIntent(text) && context.kind != "empty") {
            try {
                await parkBlock(context.blockid, text);
                refreshParked();
                setTurns((prev) => [
                    ...prev,
                    { who: "jarvis", text: `Guardado «${describeContext(context)}». Lo recuperás desde acá cuando quieras.` },
                ]);
                setContext({ kind: "empty" });
            } catch (e) {
                setTurns((prev) => [...prev, { who: "jarvis", text: `No pude guardarlo: ${e?.message ?? e}` }]);
            } finally {
                setBusy(false);
                inputRef.current?.focus();
            }
            return;
        }
        try {
            const contexts = context.kind == "empty" ? [] : [context];
            const resp = await postIntent(text, contexts);
            jarvisLog("jarvis.intent.resolve", { handled: resp.handled, needsConfirmation: resp.needs_confirmation });
            const reply = resp.handled
                ? resp.response || "Hecho."
                : "Todavía no sé resolver eso. Probá reformularlo, o usá la CLI jarvis para casos avanzados.";
            setTurns((prev) => [...prev, { who: "jarvis", text: reply }]);
        } catch (e) {
            setTurns((prev) => [...prev, { who: "jarvis", text: `No pude hablar con el cerebro: ${e?.message ?? e}` }]);
        } finally {
            setBusy(false);
            inputRef.current?.focus();
        }
    };

    return (
        <Modal
            className="w-[640px] max-w-[92vw]"
            onClose={() => modalsModel.popModal()}
            onClickBackdrop={() => modalsModel.popModal()}
        >
            <div data-command-shortcuts="always" className="bg-modal rounded overflow-hidden border border-border">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                    <span className="text-sm font-semibold text-primary">Jarvis</span>
                    <span className="text-xs text-muted">Contexto: {describeContext(context)}</span>
                </div>
                {configured == false && <BrainConfigForm onSaved={() => setConfigured(true)} />}
                {turns.length > 0 && (
                    <div ref={scrollRef} className="max-h-[320px] overflow-auto px-4 py-2 flex flex-col gap-2">
                        {turns.map((turn, i) => (
                            <div key={i} className={turn.who == "user" ? "text-sm text-secondary" : "text-sm text-primary"}>
                                <span className="text-xs text-muted mr-2">{turn.who == "user" ? "vos" : "jarvis"}</span>
                                <span className="whitespace-pre-wrap">{turn.text}</span>
                            </div>
                        ))}
                        {busy && <div className="text-sm text-muted">Jarvis está pensando…</div>}
                    </div>
                )}
                {parked.length > 0 && (
                    <div className="px-4 py-2 border-t border-border">
                        <div className="text-xs text-muted mb-1">Guardado para después</div>
                        <div className="flex flex-col gap-1 max-h-[140px] overflow-auto">
                            {parked.map((entry) => (
                                <div key={entry.blockid} className="flex items-center gap-2 text-sm">
                                    <span className="text-secondary truncate flex-1" title={entry.note ?? entry.title}>
                                        {entry.title}
                                    </span>
                                    <button
                                        className="text-xs text-primary bg-accent/80 hover:bg-accent transition-colors rounded px-2 py-0.5 cursor-pointer"
                                        onClick={() =>
                                            void restorePark(entry.blockid).then(() => {
                                                refreshParked();
                                                modalsModel.popModal();
                                            })
                                        }
                                    >
                                        Retomar
                                    </button>
                                    <button
                                        className="text-xs text-muted hover:text-primary transition-colors cursor-pointer"
                                        onClick={() => void closeParked(entry.blockid).then(refreshParked)}
                                        title="Cerrar definitivamente"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <input
                    ref={inputRef}
                    autoFocus
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            modalsModel.popModal();
                        }
                        if (e.key === "Enter") {
                            e.preventDefault();
                            void submit();
                        }
                    }}
                    placeholder="¿Qué necesitás?  (ej: seguí vos con esto y avisame cuando termine)"
                    className="w-full bg-panel px-4 py-3 outline-none text-base"
                />
            </div>
        </Modal>
    );
}

JarvisOverlay.displayName = "JarvisOverlay";
