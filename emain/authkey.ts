// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ipcMain } from "electron";
import { getWebServerEndpoint, getWSServerEndpoint } from "../frontend/util/endpoints";

const AuthKeyHeader = "X-AuthKey";
export const WaveAuthKeyEnv = "WAVETERM_AUTH_KEY";

// in attached mode the key comes from runtime.authkey (persistent, owned by
// the runtime); in legacy child mode it is random per launch as before
let authKey: string = null;

export function initAuthKey(key: string) {
    authKey = key;
}

export function getAuthKey(): string {
    if (authKey == null) {
        throw new Error("authkey not initialized");
    }
    return authKey;
}

ipcMain.on("get-auth-key", (event) => {
    event.returnValue = getAuthKey();
});

export function configureAuthKeyRequestInjection(session: Electron.Session) {
    const filter: Electron.WebRequestFilter = {
        urls: [`${getWebServerEndpoint()}/*`, `${getWSServerEndpoint()}/*`],
    };
    session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        details.requestHeaders[AuthKeyHeader] = getAuthKey();
        callback({ requestHeaders: details.requestHeaders });
    });
}
