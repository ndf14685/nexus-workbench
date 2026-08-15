// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Detached runtime attach/supervision (ADR-0006). The runtime (wavesrv
// --detached) outlives this process; we rendezvous through runtime.json and
// runtime.authkey in the data dir instead of spawning wavesrv as a child.

import { RpcApi } from "@/app/store/wshclientapi";
import * as electron from "electron";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebServerEndpointVarName, WSServerEndpointVarName } from "../frontend/util/endpoints";
import { ElectronWshClient } from "./emain-wsh";
import { initAuthKey } from "./authkey";
import {
    getElectronAppResourcesPath,
    getElectronAppUnpackedBasePath,
    getWaveConfigDir,
    getWaveDataDir,
    getWaveSrvPath,
    isDev,
} from "./emain-platform";
import { runWaveSrv, setWaveVersion, resolveWaveSrvReady } from "./emain-wavesrv";

export const RuntimeProtocolVersion = 1;
export const RuntimeTaskName = "NexusRuntime";
const RuntimeStateFileName = "runtime.json";
const RuntimeAuthKeyFileName = "runtime.authkey";
const RuntimeSpawnWaitMs = 15000;
const RuntimeSpawnPollMs = 250;

export type RuntimeState = {
    pid: number;
    startts: number;
    web: string;
    ws: string;
    version: string;
    protocol: number;
};

export type RuntimeHealth = {
    ok: boolean;
    version: string;
    buildtime: string;
    protocol: number;
    pid: number;
    detached: boolean;
};

let runtimeMode: "attached" | "child" = "child";
let attachedState: RuntimeState = null;

export function isRuntimeAttached(): boolean {
    return runtimeMode === "attached";
}

export function getAttachedRuntimeState(): RuntimeState {
    return attachedState;
}

export function readRuntimeState(): RuntimeState {
    try {
        const raw = fs.readFileSync(path.join(getWaveDataDir(), RuntimeStateFileName), "utf8");
        return JSON.parse(raw) as RuntimeState;
    } catch (e) {
        return null;
    }
}

export function readRuntimeAuthKey(): string {
    try {
        const raw = fs.readFileSync(path.join(getWaveDataDir(), RuntimeAuthKeyFileName), "utf8").trim();
        return raw.length > 0 ? raw : null;
    } catch (e) {
        return null;
    }
}

function isPidAlive(pid: number): boolean {
    if (pid == null || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

export async function probeRuntime(state: RuntimeState, authKey: string): Promise<RuntimeHealth> {
    try {
        const resp = await fetch(`http://${state.web}/wave/runtime-health`, {
            headers: { "X-AuthKey": authKey },
            signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) {
            return null;
        }
        const health = (await resp.json()) as RuntimeHealth;
        return health?.ok ? health : null;
    } catch (e) {
        return null;
    }
}

function applyAttachedEndpoints(state: RuntimeState, health: RuntimeHealth, authKey: string) {
    process.env[WSServerEndpointVarName] = state.ws;
    process.env[WebServerEndpointVarName] = state.web;
    initAuthKey(authKey);
    setWaveVersion(health.version, parseInt(health.buildtime) || 0);
    attachedState = state;
    runtimeMode = "attached";
}

// returns the health on success; "mismatch" if the runtime speaks another protocol
async function tryAttach(): Promise<RuntimeHealth | "mismatch"> {
    const state = readRuntimeState();
    if (state == null || !isPidAlive(state.pid)) {
        return null;
    }
    const authKey = readRuntimeAuthKey();
    if (authKey == null) {
        return null;
    }
    const health = await probeRuntime(state, authKey);
    if (health == null) {
        return null;
    }
    if (health.protocol !== RuntimeProtocolVersion) {
        console.log(`runtime protocol mismatch: runtime=${health.protocol} app=${RuntimeProtocolVersion}`);
        return "mismatch";
    }
    applyAttachedEndpoints(state, health, authKey);
    return health;
}

export function getRuntimeSpawnArgs(): string[] {
    return [
        "--detached",
        "--data-home",
        getWaveDataDir(),
        "--config-home",
        getWaveConfigDir(),
        "--app-path",
        getElectronAppUnpackedBasePath(),
        "--resources-path",
        getElectronAppResourcesPath(),
    ];
}

function runtimeTaskExists(): boolean {
    if (process.platform !== "win32") {
        return false;
    }
    try {
        child_process.execFileSync("schtasks", ["/query", "/tn", RuntimeTaskName], { stdio: "ignore" });
        return true;
    } catch (e) {
        return false;
    }
}

function startRuntimeViaTask(): boolean {
    if (!runtimeTaskExists()) {
        return false;
    }
    try {
        child_process.execFileSync("schtasks", ["/run", "/tn", RuntimeTaskName], { stdio: "ignore" });
        console.log("runtime start requested via scheduled task");
        return true;
    } catch (e) {
        console.log("error starting runtime via scheduled task", e);
        return false;
    }
}

function spawnRuntimeDetached() {
    const proc = child_process.spawn(getWaveSrvPath(), getRuntimeSpawnArgs(), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    proc.unref();
    console.log("runtime spawned detached, pid", proc.pid);
}

async function waitForAttach(): Promise<RuntimeHealth | "mismatch"> {
    const deadline = Date.now() + RuntimeSpawnWaitMs;
    while (Date.now() < deadline) {
        const rtn = await tryAttach();
        if (rtn != null) {
            return rtn;
        }
        await new Promise((resolve) => setTimeout(resolve, RuntimeSpawnPollMs));
    }
    return null;
}

// a protocol mismatch means the runtime binary predates (or postdates) this
// app; the binary path is stable across updates, so a restart runs current code
function stopMismatchedRuntime() {
    const state = readRuntimeState();
    if (state == null || !isPidAlive(state.pid)) {
        return;
    }
    console.log(`stopping protocol-mismatched runtime pid ${state.pid}`);
    try {
        process.kill(state.pid);
    } catch (e) {
        console.log("error stopping mismatched runtime", e);
    }
}

export async function ensureRuntime(handleWSEvent: (evtMsg: WSEventType) => void): Promise<"attached" | "child"> {
    // dev keeps the historical child workflow (task dev rebuilds wavesrv per
    // run); WAVETERM_DETACHED_DEV opts dev into the attach path for testing
    if (process.env.WAVETERM_FORCE_CHILD_MODE || (isDev && !process.env.WAVETERM_DETACHED_DEV)) {
        console.log("using legacy child wavesrv (dev/forced)");
        await startLegacyChild(handleWSEvent);
        return runtimeMode;
    }
    let attach = await tryAttach();
    if (attach === "mismatch") {
        stopMismatchedRuntime();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attach = null;
    }
    if (attach == null) {
        if (!startRuntimeViaTask()) {
            try {
                spawnRuntimeDetached();
            } catch (e) {
                console.log("error spawning detached runtime, falling back to child mode", e);
                await startLegacyChild(handleWSEvent);
                return runtimeMode;
            }
        }
        attach = await waitForAttach();
    }
    if (attach == null || attach === "mismatch") {
        console.log("could not attach to detached runtime, falling back to child mode");
        await startLegacyChild(handleWSEvent);
        return runtimeMode;
    }
    console.log(`attached to runtime (version ${attach.version}, pid ${attach.pid})`);
    resolveWaveSrvReady();
    return runtimeMode;
}

async function startLegacyChild(handleWSEvent: (evtMsg: WSEventType) => void) {
    runtimeMode = "child";
    initAuthKey(crypto.randomUUID());
    await runWaveSrv(handleWSEvent);
}

// after a runtime restart the ephemeral ports change; re-reading runtime.json
// and reapplying endpoints is the only way back without restarting the app
export async function reattachRuntime(): Promise<boolean> {
    const rtn = await tryAttach();
    return rtn != null && rtn !== "mismatch";
}

let watchdogTimer: NodeJS.Timeout = null;
let watchdogBusy = false;
let runtimeDown = false;

export function stopRuntimeWatchdog() {
    if (watchdogTimer != null) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

export async function countActiveMissionBlocks(): Promise<number> {
    try {
        const blocks = await RpcApi.BlocksListCommand(ElectronWshClient, {});
        return blocks?.filter((b) => b.meta?.["nexus:owner"] == "mission").length ?? 0;
    } catch (e) {
        console.log("error counting mission blocks", e);
        return 0;
    }
}

export async function shutdownRuntime(reason: string): Promise<boolean> {
    stopRuntimeWatchdog();
    try {
        await RpcApi.ShutdownRuntimeCommand(ElectronWshClient, { reason });
    } catch (e) {
        console.log("error requesting runtime shutdown", e);
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const state = readRuntimeState();
        if (state == null || !isPidAlive(state.pid)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log("runtime did not exit within 10s of shutdown request");
    return false;
}

// NSIS cannot replace a locked wavesrv.exe, so the runtime must stop before
// quitAndInstall; with missions active the user decides (defer keeps them alive)
export async function prepareRuntimeForUpdate(): Promise<boolean> {
    const missionCount = await countActiveMissionBlocks();
    if (missionCount > 0) {
        const { response } = await electron.dialog.showMessageBox(null, {
            type: "warning",
            buttons: ["Diferir actualización", "Actualizar igual"],
            defaultId: 0,
            cancelId: 0,
            title: "Nexus Workbench",
            message: `Hay ${missionCount} sesión(es) de misión de Jarvis activas.`,
            detail: "Actualizar ahora detiene el runtime y esas sesiones. Diferir instala la actualización más tarde, cuando no haya misiones trabajando.",
        });
        if (response === 0) {
            return false;
        }
    }
    return await shutdownRuntime("update");
}

export async function shutdownRuntimeInteractive() {
    if (!isRuntimeAttached()) {
        electron.dialog.showMessageBoxSync(null, {
            type: "info",
            buttons: ["OK"],
            title: "Nexus Workbench",
            message: "El runtime corre en modo hijo (legacy): se detiene al cerrar la app.",
        });
        return;
    }
    const missionCount = await countActiveMissionBlocks();
    const detail =
        missionCount > 0
            ? `Hay ${missionCount} sesión(es) de misión de Jarvis activas que se detendrán.`
            : "Todas las sesiones de terminal se detendrán.";
    const { response } = await electron.dialog.showMessageBox(null, {
        type: "warning",
        buttons: ["Cancelar", "Detener runtime"],
        defaultId: 0,
        cancelId: 0,
        title: "Nexus Workbench",
        message: "¿Detener el Nexus Runtime por completo?",
        detail,
    });
    if (response !== 1) {
        return;
    }
    await shutdownRuntime("menu shutdown");
    electron.app.quit();
}

export function isRuntimeDown(): boolean {
    return runtimeDown;
}

// the runtime can restart under the scheduled task at any time, changing its
// ephemeral ports; this watchdog notices, reattaches, and lets emain rewire
// clients/windows when the endpoints changed
export function startRuntimeWatchdog(
    onStatusChange: (status: "reconnecting" | "connected") => void,
    onReattached: (endpointsChanged: boolean) => Promise<void>
) {
    if (!isRuntimeAttached() || watchdogTimer != null) {
        return;
    }
    watchdogTimer = setInterval(async () => {
        if (watchdogBusy || !isRuntimeAttached()) {
            return;
        }
        watchdogBusy = true;
        try {
            const state = attachedState;
            const authKey = readRuntimeAuthKey();
            const healthy =
                state != null && authKey != null && isPidAlive(state.pid)
                    ? (await probeRuntime(state, authKey)) != null
                    : false;
            if (healthy) {
                if (runtimeDown) {
                    runtimeDown = false;
                    onStatusChange("connected");
                }
                return;
            }
            if (!runtimeDown) {
                runtimeDown = true;
                console.log("runtime connection lost, attempting reattach");
                onStatusChange("reconnecting");
            }
            const prevWeb = state?.web;
            const ok = await reattachRuntime();
            if (ok) {
                runtimeDown = false;
                const endpointsChanged = attachedState.web !== prevWeb;
                console.log(`runtime reattached (endpointsChanged: ${endpointsChanged})`);
                onStatusChange("connected");
                await onReattached(endpointsChanged);
            }
        } catch (e) {
            console.log("runtime watchdog error", e);
        } finally {
            watchdogBusy = false;
        }
    }, 5000);
}
