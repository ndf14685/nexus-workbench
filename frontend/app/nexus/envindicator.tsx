// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { FocusManager } from "@/app/store/focusManager";
import { getSettingsKeyAtom, WOS } from "@/store/global";
import { Tooltip } from "@/element/tooltip";
import { atom, useAtomValue } from "jotai";
import { memo } from "react";

const ClassColors: Record<string, string> = {
    lab: "#a371f7",
    personal: "#3fb950",
    work: "#58a6ff",
    prod: "#f85149",
};
const UnknownColor = "#8b949e";

const focusedConnAtom = atom((get) => {
    const blockId = get(FocusManager.getInstance().blockFocusAtom);
    if (!blockId) {
        return null;
    }
    const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    if (block == null) {
        return null;
    }
    return block.meta?.connection ?? "";
});

const NexusEnvIndicatorComponent = () => {
    const conn = useAtomValue(focusedConnAtom);
    const envs = useAtomValue(getSettingsKeyAtom("nexus:environments"));

    if (conn == null) {
        return null;
    }
    const env = envs?.find((e) => (e.conn ?? "") === conn);
    if (env == null && conn === "") {
        return null;
    }
    const label = env?.name ?? env?.id ?? conn;
    const color = env?.color ?? ClassColors[env?.class] ?? UnknownColor;
    const tooltip = env
        ? `${env.kind ?? "?"}${env.conn ? " " + env.conn : ""} (${env.class ?? "?"})`
        : `${conn} (fuera del catálogo Nexus)`;

    return (
        <Tooltip
            content={tooltip}
            placement="bottom"
            divClassName="flex items-center gap-1.5 px-2 mb-1 h-[22px] text-xs text-secondary bg-hoverbg rounded-sm"
            divStyle={{ WebkitAppRegion: "no-drag" } as any}
        >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
            {label}
        </Tooltip>
    );
};
NexusEnvIndicatorComponent.displayName = "NexusEnvIndicatorComponent";

export const NexusEnvIndicator = memo(NexusEnvIndicatorComponent);
