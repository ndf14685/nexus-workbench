// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { noteMetaUpdate, resolvePanelTitle, titleMetaUpdate } from "./panelidentity-util";

describe("titleMetaUpdate", () => {
    it("sets a custom title", () => {
        expect(titleMetaUpdate("CyberLab · OSINT")).toEqual({ "frame:title": "CyberLab · OSINT" });
    });
    it("trims surrounding whitespace", () => {
        expect(titleMetaUpdate("  Trading · Canary  ")).toEqual({ "frame:title": "Trading · Canary" });
    });
    it("writes null (delete/reset) for a blank value", () => {
        expect(titleMetaUpdate("")).toEqual({ "frame:title": null });
        expect(titleMetaUpdate("   ")).toEqual({ "frame:title": null });
    });
});

describe("noteMetaUpdate", () => {
    it("sets a note and keeps internal newlines", () => {
        expect(noteMetaUpdate("line1\nline2")).toEqual({ "frame:note": "line1\nline2" });
    });
    it("writes null when cleared", () => {
        expect(noteMetaUpdate("")).toEqual({ "frame:note": null });
    });
});

describe("resolvePanelTitle", () => {
    it("prefers the custom title", () => {
        expect(resolvePanelTitle("CyberLab · OSINT", false, "Preview")).toBe("CyberLab · OSINT");
    });
    it("custom title wins even for views that hide their name (terminal / web)", () => {
        expect(resolvePanelTitle("ChatGPT · Agentes", true, "")).toBe("ChatGPT · Agentes");
        expect(resolvePanelTitle("T495 · Debug", true, "")).toBe("T495 · Debug");
    });
    it("falls back to the view name when no custom title and name is shown", () => {
        expect(resolvePanelTitle("", false, "Preview")).toBe("Preview");
        expect(resolvePanelTitle(undefined, false, "Preview")).toBe("Preview");
    });
    it("renders nothing when the view hides its name and there is no custom title", () => {
        expect(resolvePanelTitle("", true, "")).toBe("");
        expect(resolvePanelTitle(undefined, true, "Web")).toBe("");
    });
    it("blank (whitespace-only) custom title falls back to auto title", () => {
        expect(resolvePanelTitle("   ", false, "Preview")).toBe("Preview");
    });
});
