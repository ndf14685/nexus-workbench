// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

const DefaultBrainUrl = "http://127.0.0.1:8770";
export const BrainTokenSecretName = "NEXUS_BRAIN_TOKEN";

export interface BrainConfig {
    url: string;
    token: string;
    configured: boolean;
}

let cachedToken: string = null;

export async function getBrainConfig(): Promise<BrainConfig> {
    const settingUrl = globalStore.get(getSettingsKeyAtom("nexus:brainurl")) as string;
    if (cachedToken == null) {
        try {
            const secrets = await RpcApi.GetSecretsCommand(TabRpcClient, [BrainTokenSecretName]);
            cachedToken = secrets?.[BrainTokenSecretName] ?? "";
        } catch {
            cachedToken = "";
        }
    }
    return {
        url: settingUrl || DefaultBrainUrl,
        token: cachedToken,
        configured: !!settingUrl && !!cachedToken,
    };
}

export async function saveBrainConfig(url: string, token: string): Promise<void> {
    await RpcApi.SetConfigCommand(TabRpcClient, { "nexus:brainurl": url });
    if (token) {
        await RpcApi.SetSecretsCommand(TabRpcClient, { [BrainTokenSecretName]: token });
        cachedToken = token;
    }
}

export function resetBrainConfigCache() {
    cachedToken = null;
}
