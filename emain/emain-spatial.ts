// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { ClientService } from "@/app/store/services";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { fireAndForget } from "@/util/util";
import { randomUUID } from "crypto";
import { BrowserWindow, screen } from "electron";
import path from "path";
import { debounce } from "throttle-debounce";
import { getGlobalIsQuitting, getGlobalIsRelaunching } from "./emain-activity";
import { computeMonitorId, moveWindowToDisplayPreservingOffset, resolveMonitor } from "./emain-displays";
import { getElectronAppBasePath, isDevVite, unamePlatform } from "./emain-platform";
import { ensureBoundsAreVisible } from "./emain-util";
import { getAllWaveWindows } from "./emain-window";
import { ElectronWshClient } from "./emain-wsh";

const DefaultSurfaceWidth = 900;
const DefaultSurfaceHeight = 600;
const MinSurfaceWidth = 300;
const MinSurfaceHeight = 200;

export type SpatialWindowType = BrowserWindow & {
    surfaceId: string;
    moduleId: string;
    workspaceId: string;
    savedInitOpts: SpatialInitOpts;
    // set before an engine-driven close (module.attached / surface.closed) so
    // the "closed" handler can tell it apart from the user closing the window,
    // which by MVP policy means Pop In (R12).
    engineClosing: boolean;
};

const spatialWindows = new Map<string, SpatialWindowType>();

export function getSpatialWindowBySurfaceId(surfaceId: string): SpatialWindowType {
    return spatialWindows.get(surfaceId);
}

export function getSpatialWindowByModuleId(moduleId: string): SpatialWindowType {
    for (const win of spatialWindows.values()) {
        if (win.moduleId === moduleId) {
            return win;
        }
    }
}

export function getSpatialWindowByWebContentsId(webContentsId: number): SpatialWindowType {
    for (const win of spatialWindows.values()) {
        if (!win.isDestroyed() && win.webContents.id === webContentsId) {
            return win;
        }
    }
}

export function getAllSpatialWindows(): SpatialWindowType[] {
    return Array.from(spatialWindows.values());
}

function computeSurfaceBounds(surface: Surface, module: ModuleInstance): Electron.Rectangle {
    const placement = surface?.bounds ?? module?.placement;
    if (placement != null && placement.width > 0 && placement.height > 0) {
        return ensureBoundsAreVisible({
            x: Math.round(placement.x),
            y: Math.round(placement.y),
            width: Math.round(placement.width),
            height: Math.round(placement.height),
        });
    }
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
        x: workArea.x + Math.max(0, Math.round((workArea.width - DefaultSurfaceWidth) / 2)),
        y: workArea.y + Math.max(0, Math.round((workArea.height - DefaultSurfaceHeight) / 2)),
        width: DefaultSurfaceWidth,
        height: DefaultSurfaceHeight,
    };
}

// Self-report de bounds de la ventana viva → SpatialMoveCommand (CONTRACTS
// §1). Incluye el monitorId del display actual para que arrastrar la ventana
// entre monitores mantenga ModuleInstance.MonitorId al día.
function reportSurfaceBounds(win: SpatialWindowType) {
    if (win.isDestroyed() || win.engineClosing) {
        return;
    }
    const bounds = win.getBounds();
    fireAndForget(async () => {
        try {
            await RpcApi.SpatialMoveCommand(ElectronWshClient, {
                moduleid: win.moduleId,
                monitorid: computeMonitorId(screen.getDisplayMatching(bounds)),
                placement: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            });
        } catch (e) {
            console.log("spatial: error persisting surface bounds", win.surfaceId, e);
        }
    });
}

export async function createDetachedWindow(
    surface: Surface,
    module: ModuleInstance,
    workspaceId: string
): Promise<SpatialWindowType> {
    if (surface?.id == null || module?.id == null) {
        throw new Error("spatial: createDetachedWindow requires surface and module");
    }
    // R7: one window per surfaceId, always.
    const existing = spatialWindows.get(surface.id);
    if (existing != null && !existing.isDestroyed()) {
        return existing;
    }
    const clientData = await ClientService.GetClientData();
    const initOpts: SpatialInitOpts = {
        surfaceId: surface.id,
        moduleId: module.id,
        tabId: module.prevdock?.tabid ?? surface.tabid ?? "",
        workspaceId,
        clientId: clientData?.oid,
        windowId: randomUUID(),
    };
    const winBounds = computeSurfaceBounds(surface, module);
    const spatialWindow = new BrowserWindow({
        x: winBounds.x,
        y: winBounds.y,
        width: winBounds.width,
        height: winBounds.height,
        minWidth: MinSurfaceWidth,
        minHeight: MinSurfaceHeight,
        titleBarStyle: unamePlatform === "darwin" ? "hiddenInset" : "default",
        icon:
            unamePlatform === "linux"
                ? path.join(getElectronAppBasePath(), "public/logos/wave-logo-dark.png")
                : undefined,
        show: false,
        backgroundColor: "#222222",
        webPreferences: {
            preload: path.join(getElectronAppBasePath(), "preload", "index.cjs"),
            webviewTag: true,
        },
    }) as SpatialWindowType;
    spatialWindow.surfaceId = surface.id;
    spatialWindow.moduleId = module.id;
    spatialWindow.workspaceId = workspaceId;
    spatialWindow.savedInitOpts = initOpts;
    spatialWindow.engineClosing = false;
    spatialWindows.set(surface.id, spatialWindow);

    spatialWindow.on(
        "resize",
        debounce(400, () => reportSurfaceBounds(spatialWindow))
    );
    spatialWindow.on(
        "move",
        debounce(400, () => reportSurfaceBounds(spatialWindow))
    );
    spatialWindow.on("closed", () => {
        console.log("spatial window closed", surface.id, "engineClosing:", spatialWindow.engineClosing);
        spatialWindows.delete(surface.id);
        if (spatialWindow.engineClosing || getGlobalIsQuitting() || getGlobalIsRelaunching()) {
            return;
        }
        // MVP policy (R12): the user closing a detached window = Pop In, the
        // module goes back to the main window instead of being lost.
        RpcApi.SpatialAttachCommand(ElectronWshClient, { moduleid: module.id }, { noresponse: true });
    });

    try {
        if (isDevVite) {
            await spatialWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html`);
        } else {
            await spatialWindow.loadFile(path.join(getElectronAppBasePath(), "frontend", "index.html"));
        }
    } catch (e) {
        spatialWindows.delete(surface.id);
        if (!spatialWindow.isDestroyed()) {
            spatialWindow.engineClosing = true;
            spatialWindow.destroy();
        }
        throw e;
    }
    spatialWindow.show();
    console.log("created spatial window", surface.id, "module:", module.id);
    return spatialWindow;
}

function closeSpatialWindowFromEngine(win: SpatialWindowType) {
    if (win == null || win.isDestroyed()) {
        return;
    }
    win.engineClosing = true;
    win.close();
}

// json.RawMessage llega inline como objeto por el bridge WPS, pero el tipo
// generado dice string; se aceptan ambos (mismo criterio que spatial-model).
function parseSpatialPayload(payload: unknown): any {
    if (payload == null) {
        return null;
    }
    if (typeof payload !== "string") {
        return payload;
    }
    try {
        return JSON.parse(payload);
    } catch (e) {
        console.log("spatial: invalid event payload", e);
        return null;
    }
}

// module.moved del engine → materializar en la ventana. Payload con placement
// = aplicar bounds (validados con ensureBoundsAreVisible, R5: lo guardado no
// se corrige, solo la materialización); sin placement pero con monitorid =
// mover al monitor conservando offset. El guard de igualdad corta el eco del
// self-report de bounds (el evento vuelve con lo que la ventana ya tiene).
function applyModuleMove(data: SpatialEventData) {
    const win = getSpatialWindowByModuleId(data.moduleid);
    if (win == null || win.isDestroyed() || win.engineClosing) {
        return;
    }
    const placement = parseSpatialPayload(data.payload) as SpatialPlacement;
    if (placement != null && placement.width > 0 && placement.height > 0) {
        const target = ensureBoundsAreVisible({
            x: Math.round(placement.x),
            y: Math.round(placement.y),
            width: Math.round(placement.width),
            height: Math.round(placement.height),
        });
        const cur = win.getBounds();
        if (cur.x !== target.x || cur.y !== target.y || cur.width !== target.width || cur.height !== target.height) {
            win.setBounds(target);
        }
        return;
    }
    if (!data.monitorid) {
        return;
    }
    const targetDisplay = resolveMonitor(data.monitorid, win.getBounds());
    if (targetDisplay == null) {
        console.log("spatial: monitor not found for move", data.monitorid);
        return;
    }
    moveWindowToDisplayPreservingOffset(win, targetDisplay);
}

async function handleModuleDetached(data: SpatialEventData) {
    const state = await RpcApi.SpatialGetStateCommand(ElectronWshClient, { workspaceid: data.workspaceid });
    const module = state?.modules?.[data.moduleid];
    const surface = state?.surfaces?.[data.surfaceid];
    if (module == null || surface == null) {
        console.log("spatial: module.detached without state, skipping", data.moduleid, data.surfaceid);
        return;
    }
    try {
        await createDetachedWindow(surface, module, data.workspaceid);
    } catch (e) {
        console.log("spatial: failed to materialize surface, rescuing module (R6)", data.moduleid, e);
        await RpcApi.SpatialAttachCommand(ElectronWshClient, { moduleid: data.moduleid });
    }
}

function handleSpatialEvent(event: WaveEvent) {
    const data = event?.data as SpatialEventData;
    if (data?.type == null) {
        return;
    }
    fireAndForget(async () => {
        switch (data.type) {
            case "module.detached":
                await handleModuleDetached(data);
                break;
            case "module.attached":
                closeSpatialWindowFromEngine(getSpatialWindowByModuleId(data.moduleid));
                break;
            case "surface.closed":
                closeSpatialWindowFromEngine(spatialWindows.get(data.surfaceid));
                break;
            case "module.moved":
                applyModuleMove(data);
                break;
        }
    });
}

export function initSpatialEventSubscription() {
    waveEventSubscribeSingle({
        eventType: "spatial:update",
        handler: handleSpatialEvent,
    });
}

// Startup reconciliation (R6/R12): recreate one window per detached module of
// every open workspace; a detached module whose surface cannot be
// materialized gets rescued back into the main window.
export async function reconcileSpatialWindows() {
    const workspaceIds = new Set<string>();
    for (const ww of getAllWaveWindows()) {
        if (ww.workspaceId) {
            workspaceIds.add(ww.workspaceId);
        }
    }
    for (const workspaceId of workspaceIds) {
        try {
            const state = await RpcApi.SpatialGetStateCommand(ElectronWshClient, { workspaceid: workspaceId });
            for (const [moduleId, module] of Object.entries(state?.modules ?? {})) {
                if (!module?.isdetached) {
                    continue;
                }
                const surface = state?.surfaces?.[module.currentsurfaceid];
                if (surface == null) {
                    console.log("spatial: detached module without surface, rescuing (R6)", moduleId);
                    await RpcApi.SpatialAttachCommand(ElectronWshClient, { moduleid: moduleId });
                    continue;
                }
                try {
                    await createDetachedWindow(surface, module, workspaceId);
                } catch (e) {
                    console.log("spatial: failed to restore surface, rescuing module (R6)", moduleId, e);
                    await RpcApi.SpatialAttachCommand(ElectronWshClient, { moduleid: moduleId });
                }
            }
        } catch (e) {
            console.log("spatial: reconciliation failed for workspace", workspaceId, e);
        }
    }
}
