// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM, PlatformWindows } from "@/util/platformutil";
import { isWslConnName } from "@/util/util";
import * as React from "react";

export type TerminalOsIdentity = "windows" | "ubuntu" | "debian" | "linux" | "neutral";
export type TerminalToolIdentity = "codex" | "claude" | null;

export function resolveTerminalOsIdentity(connection: string | null | undefined, configured: string | null | undefined, localShellPath: string | null | undefined): TerminalOsIdentity {
    const explicit = configured?.trim().toLowerCase();
    if (["windows", "ubuntu", "debian", "linux", "neutral"].includes(explicit ?? "")) return explicit as TerminalOsIdentity;
    const hint = `${connection ?? ""} ${localShellPath ?? ""}`.toLowerCase();
    if (hint.includes("ubuntu")) return "ubuntu";
    if (hint.includes("debian")) return "debian";
    if (isWslConnName(connection ?? "")) return "linux";
    if ((!connection || connection === "local") && (PLATFORM === PlatformWindows || /pwsh|powershell/.test(hint))) return "windows";
    return "neutral";
}

function Mark({ os, tool }: { os: TerminalOsIdentity; tool: TerminalToolIdentity }) {
    if (tool === "codex") return <><rect x="18" y="18" width="20" height="20" rx="3"/><path d="M24 13h8v7M32 36h-8v-7M13 24v8h7M36 32v-8h-7"/></>;
    if (tool === "claude") return <><path d="M15 36c8-18 13-23 22-23-2 11-8 20-22 23Z"/><circle cx="31" cy="20" r="2"/></>;
    if (os === "windows") return <><rect x="13" y="14" width="16" height="16"/><rect x="31" y="12" width="17" height="18"/><rect x="13" y="32" width="16" height="17"/><rect x="31" y="32" width="17" height="17"/></>;
    if (os === "ubuntu") return <><circle cx="31" cy="31" r="15"/><circle cx="31" cy="31" r="7"/><circle cx="31" cy="12" r="4"/><circle cx="48" cy="40" r="4"/><circle cx="15" cy="40" r="4"/></>;
    if (os === "debian") return <path d="M39 16c-15-8-25 10-15 22 8 10 24 2 17-9-4-6-13-2-11 4 1 4 7 3 7-1"/>;
    if (os === "linux") return <><ellipse cx="31" cy="38" rx="13" ry="14"/><circle cx="25" cy="27" r="3"/><circle cx="37" cy="27" r="3"/><path d="M25 35h12l-6 6Z"/></>;
    return <><circle cx="31" cy="31" r="16"/><path d="M31 20v12M31 40h.1"/></>;
}

export function TerminalIdentity({ os, tool, hasContent }: { os: TerminalOsIdentity; tool: TerminalToolIdentity; hasContent: boolean }) {
    return <div className={`term-identity${hasContent ? " term-identity-has-content" : ""}`} aria-hidden="true"><svg viewBox="0 0 62 62" focusable="false"><Mark os={os} tool={tool}/></svg></div>;
}
