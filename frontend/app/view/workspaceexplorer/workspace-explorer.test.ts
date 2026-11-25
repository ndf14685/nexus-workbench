import { describe, expect, it } from "vitest";
import { fileInfoToTreeNode, joinWorkspacePath } from "./workspace-explorer";

describe("workspace explorer helpers", () => {
    it("maps RPC file information into accessible tree nodes", () => {
        expect(fileInfoToTreeNode({ path: "/work/src", name: "src", isdir: true, mimetype: "directory" })).toEqual({
            id: "/work/src",
            path: "/work/src",
            label: "src",
            isDirectory: true,
            mimeType: "directory",
            isReadonly: false,
            notfound: false,
            staterror: undefined,
            childrenStatus: "unloaded",
        });
    });

    it("joins unix and Windows workspace paths without traversal magic", () => {
        expect(joinWorkspacePath("/work", "src")).toBe("/work/src");
        expect(joinWorkspacePath("C:\\work", "src")).toBe("C:\\work\\src");
        expect(() => joinWorkspacePath("/work", "../secret")).toThrow(/child name/i);
    });
});
