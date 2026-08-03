// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildPermissionContext, permissionFromElectron, validatePermissionRequest } from "./permission-policy";

describe("Nexus web permission policy", () => {
    it("maps audio media requests to microphone", () => {
        expect(permissionFromElectron("media", { mediaTypes: ["audio"] })).toBe("microphone");
        expect(permissionFromElectron("audioCapture", {})).toBe("microphone");
    });

    it("keeps camera separate from microphone and requires its own decision", () => {
        const ctx = buildPermissionContext("media", { requestingUrl: "https://chatgpt.com/", mediaTypes: ["video"] }, { moduleId: "chatgpt" });
        expect(ctx.permission).toBe("camera");
        expect(validatePermissionRequest(ctx)).toBeNull();
    });

    it("blocks insecure origins", () => {
        const ctx = buildPermissionContext("media", { requestingUrl: "http://example.com/", mediaTypes: ["audio"] }, { moduleId: "browser" });
        expect(validatePermissionRequest(ctx)).toMatchObject({ allowed: false, reason: "insecure-origin" });
    });

    it("isolates origins", () => {
        const a = buildPermissionContext("media", { requestingUrl: "https://chatgpt.com/voice", mediaTypes: ["audio"] }, { moduleId: "chatgpt" });
        const b = buildPermissionContext("media", { requestingUrl: "https://claude.ai/new", mediaTypes: ["audio"] }, { moduleId: "claude" });
        expect(a.origin).toBe("https://chatgpt.com");
        expect(b.origin).toBe("https://claude.ai");
    });

    it("allows local development origins to ask for permissions", () => {
        const ctx = buildPermissionContext("media", { requestingUrl: "http://localhost:3000/", mediaTypes: ["audio"] }, { moduleId: "browser" });
        expect(validatePermissionRequest(ctx)).toBeNull();
    });
});
