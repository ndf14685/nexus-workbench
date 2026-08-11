// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure helpers for the per-panel identity layer (custom title + note). Kept dependency-light so they
// can be unit tested without pulling in floating-ui / RPC. See panelidentity.tsx for the UI.
//
// customTitle is persisted in the existing "frame:title" block meta key (it already overrides the view
// name in the header and is never auto-written by a view). "frame:note" is the companion note.

// a blank value writes null, which MergeMeta treats as a delete (falls back to the auto title / no note)
export function titleMetaUpdate(value: string): MetaType {
    const clean = value?.trim() ?? "";
    return { "frame:title": clean === "" ? null : clean };
}

export function noteMetaUpdate(value: string): MetaType {
    const clean = value?.trim() ?? "";
    return { "frame:note": clean === "" ? null : clean };
}

// customTitle wins; otherwise fall back to the view's own name unless the view hides it (term/web)
export function resolvePanelTitle(customTitle: string, hideViewName: boolean, autoTitle: string): string {
    if (customTitle != null && customTitle.trim() !== "") {
        return customTitle;
    }
    if (hideViewName) {
        return "";
    }
    return autoTitle ?? "";
}
