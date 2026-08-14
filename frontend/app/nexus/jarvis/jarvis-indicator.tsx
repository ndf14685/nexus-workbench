// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { Tooltip } from "@/app/element/tooltip";
import { modalsModel } from "@/app/store/modalmodel";
import { useAtomValue } from "jotai";
import { memo, useEffect } from "react";
import { JarvisStatusModel, missionLabel } from "./status-model";

const JarvisIndicatorComponent = () => {
    const model = JarvisStatusModel.getInstance();
    const missions = useAtomValue(model.missionsAtom);
    const working = useAtomValue(model.workingCountAtom);
    const attention = useAtomValue(model.attentionCountAtom);
    const available = useAtomValue(model.availableAtom);

    useEffect(() => {
        model.start();
    }, []);

    if (!available || (working == 0 && attention == 0)) {
        return null;
    }
    const parts = [];
    if (working > 0) parts.push(`${working} trabajando`);
    if (attention > 0) parts.push(`${attention} atención`);
    const active = missions.filter((m) =>
        ["running", "recovering", "needs_input", "blocked"].includes(m.status)
    );
    const tooltip = active
        .slice(0, 8)
        .map((m) => `${missionLabel(m)} — ${m.status == "running" ? "trabajando" : m.status == "recovering" ? "reconectando" : m.status == "blocked" ? "bloqueada" : "necesita decisión"}`)
        .join("\n");

    return (
        <Tooltip
            content={tooltip || "Jarvis"}
            placement="bottom"
            divClassName="flex items-center gap-1.5 px-2 mb-1 h-[22px] text-xs text-secondary bg-hoverbg rounded-sm cursor-pointer"
            divStyle={{ WebkitAppRegion: "no-drag" } as any}
            divOnClick={() => {
                if (!modalsModel.isModalOpen("JarvisOverlay")) {
                    modalsModel.pushModal("JarvisOverlay", {});
                }
            }}
        >
            <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: attention > 0 ? "#d29922" : "#7ee0e6" }}
            />
            Jarvis · {parts.join(" · ")}
        </Tooltip>
    );
};
JarvisIndicatorComponent.displayName = "JarvisIndicatorComponent";

export const JarvisIndicator = memo(JarvisIndicatorComponent);
