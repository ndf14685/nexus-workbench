// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { fireAndForget } from "@/util/util";
import { BrowserWindow, ipcMain, screen } from "electron";
import { debounce } from "throttle-debounce";
import { ElectronWshClient } from "./emain-wsh";

// monitorId compuesto (DATA_MODEL §6): display.id no es estable entre
// reinicios; label+resolución+scale sí suele serlo. Con label vacío se usa
// display.id como componente (mejor que nada, sigue llevando la resolución).
export function computeMonitorId(display: Electron.Display): string {
    const labelPart = display.label?.trim() ? display.label.trim() : String(display.id);
    return `${labelPart}|${display.size.width}x${display.size.height}@${display.scaleFactor}`;
}

export function buildMonitorInfo(): MonitorInfo[] {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display) => ({
        monitorid: computeMonitorId(display),
        displayid: display.id,
        label: display.label ?? "",
        bounds: { ...display.bounds },
        workarea: { ...display.workArea },
        scalefactor: display.scaleFactor,
        primary: display.id === primaryId,
        internal: display.internal ?? false,
    }));
}

// monitorId → Display vigente; gemelos (mismo id compuesto) se desempatan por
// bounds más cercanos a ref (R4). null = el monitor ya no existe.
export function resolveMonitor(monitorId: string, ref?: Electron.Rectangle): Electron.Display {
    if (!monitorId) {
        return null;
    }
    const matches = screen.getAllDisplays().filter((display) => computeMonitorId(display) === monitorId);
    if (matches.length === 0) {
        return null;
    }
    if (matches.length === 1 || ref == null) {
        return matches[0];
    }
    let best = matches[0];
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const display of matches) {
        const dist = Math.abs(display.bounds.x - ref.x) + Math.abs(display.bounds.y - ref.y);
        if (dist < bestDist) {
            best = display;
            bestDist = dist;
        }
    }
    return best;
}

// Mismo patrón que moveWindowToDisplay de emain-window.ts (que es privado y
// está tipado para WaveBrowserWindow): conserva el offset relativo al workArea.
export function moveWindowToDisplayPreservingOffset(win: BrowserWindow, targetDisplay: Electron.Display) {
    if (!win || !targetDisplay || win.isDestroyed()) {
        return;
    }
    const curBounds = win.getBounds();
    const sourceDisplay = screen.getDisplayMatching(curBounds);
    if (sourceDisplay.id === targetDisplay.id) {
        return;
    }
    const sourceArea = sourceDisplay.workArea;
    const targetArea = targetDisplay.workArea;
    const nextHeight = Math.min(curBounds.height, targetArea.height);
    const nextWidth = Math.min(curBounds.width, targetArea.width);
    const maxXOffset = Math.max(0, targetArea.width - nextWidth);
    const maxYOffset = Math.max(0, targetArea.height - nextHeight);
    const sourceXOffset = curBounds.x - sourceArea.x;
    const sourceYOffset = curBounds.y - sourceArea.y;
    const nextX = targetArea.x + Math.min(Math.max(sourceXOffset, 0), maxXOffset);
    const nextY = targetArea.y + Math.min(Math.max(sourceYOffset, 0), maxYOffset);
    win.setBounds({ x: nextX, y: nextY, width: nextWidth, height: nextHeight });
}

export async function pushMonitorCatalog() {
    try {
        await RpcApi.SpatialUpdateMonitorsCommand(ElectronWshClient, buildMonitorInfo());
    } catch (e) {
        console.log("spatial: error pushing monitor catalog", e);
    }
}

function boundsIntersect(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Ventanas detached cuyo display desapareció → primario, conservando offset
// (R5). Se llama DESPUÉS de pushMonitorCatalog: el engine ya capturó los
// placements originales en MonitorMemory; el 'move' resultante reporta los
// bounds nuevos sin pisar esa memoria.
function repositionOrphanWindows(getSpatialWindows: () => BrowserWindow[]) {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    for (const win of getSpatialWindows()) {
        if (win == null || win.isDestroyed()) {
            continue;
        }
        const bounds = win.getBounds();
        if (!displays.some((display) => boundsIntersect(display.bounds, bounds))) {
            moveWindowToDisplayPreservingOffset(win, primary);
        }
    }
}

export function initDisplays(getSpatialWindows: () => BrowserWindow[]) {
    ipcMain.handle("get-displays", () => buildMonitorInfo());
    const handleDisplayChange = debounce(300, () =>
        fireAndForget(async () => {
            await pushMonitorCatalog();
            repositionOrphanWindows(getSpatialWindows);
        })
    );
    screen.on("display-added", handleDisplayChange);
    screen.on("display-removed", handleDisplayChange);
    screen.on("display-metrics-changed", handleDisplayChange);
    fireAndForget(pushMonitorCatalog);
}
