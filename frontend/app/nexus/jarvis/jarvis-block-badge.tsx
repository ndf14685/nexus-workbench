// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { Tooltip } from "@/app/element/tooltip";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { JarvisStatusModel, missionLabel } from "./status-model";

const StatusColors: Record<string, string> = {
    running: "#3fb950",
    recovering: "#d29922",
    needs_input: "#d29922",
    blocked: "#f85149",
    completed: "#7ee0e6",
};

interface JarvisBlockBadgeProps {
    missionId: string;
}

const JarvisBlockBadgeComponent = ({ missionId }: JarvisBlockBadgeProps) => {
    const model = JarvisStatusModel.getInstance();
    const missions = useAtomValue(model.missionsAtom);
    const mission = missions.find((m) => m.mission_id == missionId);
    const status = mission?.status ?? "";
    const tooltip = mission
        ? `${missionLabel(mission)} — ${status}`
        : "Terminal controlada por Jarvis";

    return (
        <Tooltip
            content={tooltip}
            placement="bottom"
            divClassName="flex items-center gap-1 px-1.5 text-xs text-secondary shrink-0"
        >
            <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: StatusColors[status] ?? "#8b949e" }}
            />
            Jarvis
        </Tooltip>
    );
};
JarvisBlockBadgeComponent.displayName = "JarvisBlockBadgeComponent";

export const JarvisBlockBadge = memo(JarvisBlockBadgeComponent);
