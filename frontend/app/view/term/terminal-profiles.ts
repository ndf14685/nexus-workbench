// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

export type TerminalProfileName = "default" | "focus" | "developer" | "operations";

export function terminalProfileMeta(profile: TerminalProfileName): Partial<MetaType> {
    if (profile === "focus") {
        return {
            "term:metrics": "off",
            "term:fontsize": 13,
            "term:transparency": 0,
            "term:cursor": "block",
            "term:cursorblink": false,
        };
    }
    if (profile === "developer") {
        return {
            "term:metrics": "compact",
            "term:fontsize": 12,
            "term:transparency": 0.5,
            "term:cursor": "bar",
            "term:cursorblink": true,
        };
    }
    if (profile === "operations") {
        return {
            "term:metrics": "full",
            "term:fontsize": 11,
            "term:transparency": 0,
            "term:cursor": "bar",
            "term:cursorblink": true,
        };
    }
    return {
        "term:metrics": null,
        "term:fontsize": null,
        "term:transparency": null,
        "term:cursor": null,
        "term:cursorblink": null,
    };
}
