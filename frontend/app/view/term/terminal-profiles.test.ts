import { describe, expect, it } from "vitest";
import { terminalProfileMeta } from "./terminal-profiles";

describe("terminalProfileMeta", () => {
    it("creates a low-noise focus profile", () => {
        expect(terminalProfileMeta("focus")).toMatchObject({
            "term:metrics": "off",
            "term:fontsize": 13,
            "term:transparency": 0,
        });
    });

    it("creates an operations profile with full metrics", () => {
        expect(terminalProfileMeta("operations")).toMatchObject({
            "term:metrics": "full",
            "term:cursor": "bar",
            "term:cursorblink": true,
        });
    });

    it("resets only profile-owned fields", () => {
        expect(terminalProfileMeta("default")).toEqual({
            "term:metrics": null,
            "term:fontsize": null,
            "term:transparency": null,
            "term:cursor": null,
            "term:cursorblink": null,
        });
    });
});
