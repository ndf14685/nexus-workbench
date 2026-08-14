// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { inferRepo } from "./repo-infer";

const environments = [
    { id: "rig3060", conn: "rig3060", workspaces: ["~/workspace", "/home/ndf/workspace"] },
    { id: "local-windows", conn: "", workspaces: ["C:/Users/ndf14/workspace"] },
    { id: "nexusos", conn: "nexusos" },
] as NexusEnvType[];

describe("inferRepo", () => {
    it("infers the repo root under a declared workspace", () => {
        expect(inferRepo("/home/ndf/workspace/idp-platform/src/deep", "rig3060", environments)).toEqual({
            repo: "/home/ndf/workspace/idp-platform",
            environmentId: "rig3060",
        });
    });

    it("handles windows paths with backslashes", () => {
        expect(inferRepo("C:\\Users\\ndf14\\workspace\\nexus-workbench\\frontend", "", environments)).toEqual({
            repo: "C:/Users/ndf14/workspace/nexus-workbench",
            environmentId: "local-windows",
        });
    });

    it("skips tilde workspaces instead of guessing", () => {
        expect(inferRepo("~/workspace/idp-platform", "rig3060", environments)).toEqual({ environmentId: "rig3060" });
    });

    it("returns only the environment when cwd is outside every workspace", () => {
        expect(inferRepo("/etc", "rig3060", environments)).toEqual({ environmentId: "rig3060" });
    });

    it("returns empty when nothing matches", () => {
        expect(inferRepo("/home/x", "otherhost", environments)).toEqual({});
        expect(inferRepo("", "rig3060", environments)).toEqual({});
    });

    it("does not match a sibling directory that shares the prefix", () => {
        expect(inferRepo("/home/ndf/workspace-backup/repo", "rig3060", environments)).toEqual({
            environmentId: "rig3060",
        });
    });
});
