// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";
import { JarvisActivityState } from "./jarvis-types";
import "./jarvis.css";

type JarvisRingProps = {
    state: JarvisActivityState;
    size: number; // px
};

// Own identity: concentric arcs + dash ticks. Inspired by sci-fi HUD rings,
// zero copied assets.
const JarvisRing = memo(({ state, size }: JarvisRingProps) => {
    const r = size / 2;
    const stroke = Math.max(2, size / 40);
    return (
        <div className="jarvis-ring" data-state={state} style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <g className="ring-outer">
                    <circle
                        cx={r}
                        cy={r}
                        r={r - stroke}
                        fill="none"
                        stroke="var(--jarvis-color)"
                        strokeWidth={stroke}
                        strokeLinecap="round"
                        strokeDasharray={`${(r - stroke) * 2.4} ${(r - stroke) * 4}`}
                        opacity={0.9}
                    />
                </g>
                <g className="ring-dashes">
                    <circle
                        cx={r}
                        cy={r}
                        r={r - stroke * 3.2}
                        fill="none"
                        stroke="var(--jarvis-color)"
                        strokeWidth={stroke * 0.6}
                        strokeDasharray={`${stroke * 0.8} ${stroke * 2.4}`}
                        opacity={0.5}
                    />
                </g>
                <g className="ring-core">
                    <circle cx={r} cy={r} r={Math.max(2.5, size / 14)} fill="var(--jarvis-color)" opacity={0.85} />
                    <circle
                        cx={r}
                        cy={r}
                        r={Math.max(5, size / 7)}
                        fill="none"
                        stroke="var(--jarvis-color)"
                        strokeWidth={stroke * 0.5}
                        opacity={0.6}
                    />
                </g>
            </svg>
        </div>
    );
});
JarvisRing.displayName = "JarvisRing";

export { JarvisRing };
