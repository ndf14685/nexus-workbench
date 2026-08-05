// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import type { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";

export type NexusAuditEnv = WaveEnvSubset<{
    electron: {
        getDataDir: WaveEnv["electron"]["getDataDir"];
    };
    rpc: {
        FileReadCommand: WaveEnv["rpc"]["FileReadCommand"];
    };
}>;
