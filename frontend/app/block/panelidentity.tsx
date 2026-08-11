// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Tooltip } from "@/app/element/tooltip";
import { WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { noteMetaUpdate, resolvePanelTitle, titleMetaUpdate } from "./panelidentity-util";
import {
    autoUpdate,
    flip,
    FloatingPortal,
    offset,
    shift,
    useDismiss,
    useFloating,
    useInteractions,
} from "@floating-ui/react";
import * as jotai from "jotai";
import * as React from "react";

// customTitle is stored in the existing "frame:title" block meta key (it already overrides the view
// name in the header and is never auto-written by a view). "frame:note" is the companion note. Both
// persist via SetMetaCommand into the block object, so they survive reload / workspace restore.

export { resolvePanelTitle };

export function setPanelTitle(blockId: string, value: string) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", blockId),
            meta: titleMetaUpdate(value),
        })
    );
}

export function setPanelNote(blockId: string, value: string) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", blockId),
            meta: noteMetaUpdate(value),
        })
    );
}

export function resetPanelTitle(blockId: string) {
    setPanelTitle(blockId, "");
}

type PanelEditorState = { open: boolean; focus: "title" | "note" };

const panelEditorAtoms = new Map<string, jotai.PrimitiveAtom<PanelEditorState>>();

export function getPanelEditorAtom(blockId: string): jotai.PrimitiveAtom<PanelEditorState> {
    let atom = panelEditorAtoms.get(blockId);
    if (atom == null) {
        atom = jotai.atom<PanelEditorState>({ open: false, focus: "title" });
        panelEditorAtoms.set(blockId, atom);
    }
    return atom;
}

export function openPanelEditor(blockId: string, focus: "title" | "note") {
    globalStore.set(getPanelEditorAtom(blockId), { open: true, focus });
}

export function closePanelEditor(blockId: string) {
    globalStore.set(getPanelEditorAtom(blockId), { open: false, focus: "title" });
}

type PanelTitleDisplayProps = {
    text: string; // resolved title: customTitle if set, otherwise the view name
    isCustom: boolean;
    note?: string;
    activity?: string; // AI-generated activity summary (Phase G); usually empty today
    autoTitle?: string; // technical/original view name (shown in tooltip when a custom title hides it)
    connection?: string;
    cwd?: string;
    className?: string;
    onEdit?: () => void;
};

export const PanelTitleDisplay = React.memo(
    ({ text, isCustom, note, activity, autoTitle, connection, cwd, className, onEdit }: PanelTitleDisplayProps) => {
        if (text == null || text === "") {
            return null;
        }
        const showAutoTitle = isCustom && autoTitle != null && autoTitle !== "" && autoTitle !== text;
        const hasContext = !!note || !!activity || !!connection || !!cwd || showAutoTitle;
        const tooltipContent = (
            <div className="flex flex-col gap-1 max-w-[320px]">
                <div className="font-semibold">{text}</div>
                {activity && <div className="italic opacity-90">{activity}</div>}
                {note && <div className="opacity-80 whitespace-pre-wrap">{note}</div>}
                {(showAutoTitle || connection || cwd) && (
                    <div className="opacity-60 text-[11px] flex flex-col gap-0.5 mt-0.5">
                        {showAutoTitle && <span>{autoTitle}</span>}
                        {connection && <span>Conn: {connection}</span>}
                        {cwd && <span>Path: {cwd}</span>}
                    </div>
                )}
            </div>
        );
        return (
            <Tooltip
                content={tooltipContent}
                placement="bottom"
                disable={!hasContext}
                divClassName={cn("block-frame-view-type ellipsis min-w-0", onEdit && "cursor-pointer", className)}
                divOnClick={undefined}
            >
                <div
                    className="flex items-center gap-1 min-w-0"
                    onDoubleClick={
                        onEdit
                            ? (e) => {
                                  e.stopPropagation();
                                  onEdit();
                              }
                            : undefined
                    }
                >
                    <span className="ellipsis">{text}</span>
                    {note && <i className="fa-sharp fa-solid fa-note-sticky text-[10px] opacity-50" />}
                </div>
            </Tooltip>
        );
    }
);
PanelTitleDisplay.displayName = "PanelTitleDisplay";

type PanelIdentityEditorProps = {
    blockId: string;
    anchorRef: React.RefObject<HTMLElement>;
    initialTitle?: string;
    initialNote?: string;
};

export const PanelIdentityEditor = ({ blockId, anchorRef, initialTitle, initialNote }: PanelIdentityEditorProps) => {
    const editorState = jotai.useAtomValue(getPanelEditorAtom(blockId));
    const open = editorState.open;
    const [title, setTitle] = React.useState(initialTitle ?? "");
    const [note, setNote] = React.useState(initialNote ?? "");
    const titleRef = React.useRef<HTMLInputElement>(null);
    const noteRef = React.useRef<HTMLTextAreaElement>(null);

    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: (o) => {
            if (!o) {
                closePanelEditor(blockId);
            }
        },
        placement: "bottom-start",
        middleware: [offset(4), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
        elements: { reference: anchorRef.current ?? undefined },
    });
    const dismiss = useDismiss(context);
    const { getFloatingProps } = useInteractions([dismiss]);

    React.useEffect(() => {
        if (!open) {
            return;
        }
        setTitle(initialTitle ?? "");
        setNote(initialNote ?? "");
        const t = window.setTimeout(() => {
            if (editorState.focus === "note") {
                noteRef.current?.focus();
            } else {
                titleRef.current?.focus();
                titleRef.current?.select();
            }
        }, 10);
        return () => window.clearTimeout(t);
    }, [open, editorState.focus]);

    if (!open || anchorRef.current == null) {
        return null;
    }

    const commit = () => {
        setPanelTitle(blockId, title);
        setPanelNote(blockId, note);
        closePanelEditor(blockId);
    };
    const cancel = () => closePanelEditor(blockId);
    const reset = () => {
        resetPanelTitle(blockId);
        setTitle("");
        titleRef.current?.focus();
    };

    return (
        <FloatingPortal>
            <div
                ref={refs.setFloating}
                style={floatingStyles}
                {...getFloatingProps()}
                className="z-50 flex w-[280px] flex-col gap-1.5 rounded-md border border-border bg-zinc-800 p-2.5 text-xs shadow-xl"
                onKeyDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <label className="opacity-60">Panel title</label>
                <input
                    ref={titleRef}
                    className="rounded border border-border bg-zinc-900 px-2 py-1 text-foreground outline-none focus:border-accent"
                    value={title}
                    placeholder="e.g. CyberLab · OSINT"
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancel();
                        }
                    }}
                />
                <label className="mt-1 opacity-60">Note</label>
                <textarea
                    ref={noteRef}
                    className="resize-none rounded border border-border bg-zinc-900 px-2 py-1 text-foreground outline-none focus:border-accent"
                    value={note}
                    rows={3}
                    placeholder="What are you doing here? (⌘/Ctrl+Enter to save)"
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") {
                            e.preventDefault();
                            cancel();
                        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            commit();
                        }
                    }}
                />
                <div className="mt-1 flex items-center justify-between">
                    <button
                        className="rounded px-2 py-1 text-secondary hover:text-foreground cursor-pointer"
                        onClick={reset}
                    >
                        Reset title
                    </button>
                    <div className="flex gap-1.5">
                        <button
                            className="rounded px-2 py-1 text-secondary hover:text-foreground cursor-pointer"
                            onClick={cancel}
                        >
                            Cancel
                        </button>
                        <button
                            className="rounded bg-accent/80 px-2 py-1 text-primary transition-colors hover:bg-accent cursor-pointer"
                            onClick={commit}
                        >
                            Save
                        </button>
                    </div>
                </div>
            </div>
        </FloatingPortal>
    );
};
