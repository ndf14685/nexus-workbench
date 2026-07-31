// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { App } from "@/app/app";
import { loadMonaco } from "@/app/monaco/monaco-env";
import { loadBadges } from "@/app/store/badge";
import { GlobalModel } from "@/app/store/global-model";
import {
    globalRefocus,
    registerBuilderGlobalKeys,
    registerControlShiftStateUpdateHandler,
    registerElectronReinjectKeyHandler,
    registerGlobalKeys,
} from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { SpatialModel } from "@/app/nexus/spatial/spatial-model"; // nexus:
import { SurfaceApp } from "@/app/nexus/spatial/surfaceapp"; // nexus:
import { makeBuilderRouteId, makeSurfaceRouteId, makeTabRouteId } from "@/app/store/wshrouter"; // nexus: makeSurfaceRouteId
import { initWshrpc, TabRpcClient } from "@/app/store/wshrpcutil";
import { BuilderApp } from "@/builder/builder-app";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { countersClear, countersPrint } from "@/store/counters";
import {
    atoms,
    getApi,
    globalStore,
    initGlobal,
    initGlobalWaveEventSubs,
    loadConnStatus,
    subscribeToConnEvents,
} from "@/store/global";
import { activeTabIdAtom } from "@/store/tab-model";
import * as WOS from "@/store/wos";
import { loadFonts } from "@/util/fontutil";
import { setKeyUtilPlatform } from "@/util/keyutil";
import { isMacOS, setMacOSVersion } from "@/util/platformutil";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

const platform = getApi().getPlatform();
document.title = `Nexus Workbench`;
let savedInitOpts: WaveInitOpts = null;

(window as any).WOS = WOS;
(window as any).globalStore = globalStore;
(window as any).globalAtoms = atoms;
(window as any).RpcApi = RpcApi;
(window as any).isFullScreen = false;
(window as any).countersPrint = countersPrint;
(window as any).countersClear = countersClear;
(window as any).getLayoutModelForStaticTab = getLayoutModelForStaticTab;
(window as any).modalsModel = modalsModel;

function updateZoomFactor(zoomFactor: number) {
    console.log("update zoomfactor", zoomFactor);
    document.documentElement.style.setProperty("--zoomfactor", String(zoomFactor));
    document.documentElement.style.setProperty("--zoomfactor-inv", String(1 / zoomFactor));
}

async function initBare() {
    getApi().sendLog("Init Bare");
    document.body.style.visibility = "hidden";
    document.body.style.opacity = "0";
    document.body.classList.add("is-transparent");
    getApi().onWaveInit(initWaveWrap);
    getApi().onBuilderInit(initBuilderWrap);
    getApi().onSpatialInit(initSurfaceWrap); // nexus:
    setKeyUtilPlatform(platform);
    loadFonts();
    updateZoomFactor(getApi().getZoomFactor());
    getApi().onZoomFactorChange((zoomFactor) => {
        updateZoomFactor(zoomFactor);
    });
    document.fonts.ready.then(() => {
        console.log("Init Bare Done");
        getApi().setWindowInitStatus("ready");
    });
}

document.addEventListener("DOMContentLoaded", initBare);

async function initWaveWrap(initOpts: WaveInitOpts) {
    try {
        if (savedInitOpts) {
            await reinitWave();
            return;
        }
        savedInitOpts = initOpts;
        await initWave(initOpts);
    } catch (e) {
        getApi().sendLog("Error in initWave " + e.message + "\n" + e.stack);
        console.error("Error in initWave", e);
    } finally {
        document.body.style.visibility = null;
        document.body.style.opacity = null;
        document.body.classList.remove("is-transparent");
    }
}

async function reinitWave() {
    console.log("Reinit Wave");
    getApi().sendLog("Reinit Wave");

    // We use this hack to prevent a flicker of the previously-hovered tab when this view was last active.
    document.body.classList.add("nohover");
    requestAnimationFrame(() =>
        setTimeout(() => {
            document.body.classList.remove("nohover");
        }, 100)
    );

    await WOS.reloadWaveObject<Client>(WOS.makeORef("client", savedInitOpts.clientId));
    const waveWindow = await WOS.reloadWaveObject<WaveWindow>(WOS.makeORef("window", savedInitOpts.windowId));
    const ws = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid));
    const initialTab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", savedInitOpts.tabId));
    await WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", initialTab.layoutstate));
    reloadAllWorkspaceTabs(ws);
    document.title = `Nexus Workbench - ${initialTab.name}`; // TODO update with tab name change
    getApi().setWindowInitStatus("wave-ready");
    globalStore.set(atoms.reinitVersion, globalStore.get(atoms.reinitVersion) + 1);
    globalStore.set(atoms.updaterStatusAtom, getApi().getUpdaterStatus());
    setTimeout(() => {
        globalRefocus();
    }, 50);
}

function reloadAllWorkspaceTabs(ws: Workspace) {
    if (ws == null || !ws.tabids?.length) {
        return;
    }
    ws.tabids?.forEach((tabid) => {
        WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabid));
    });
}

function loadAllWorkspaceTabs(ws: Workspace) {
    if (ws == null || !ws.tabids?.length) {
        return;
    }
    ws.tabids?.forEach((tabid) => {
        WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabid));
    });
}

async function initWave(initOpts: WaveInitOpts) {
    getApi().sendLog("Init Wave " + JSON.stringify(initOpts));
    const globalInitOpts: GlobalInitOptions = {
        tabId: initOpts.tabId,
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        platform,
        environment: "renderer",
        primaryTabStartup: initOpts.primaryTabStartup,
    };
    console.log("Wave Init", globalInitOpts);
    globalStore.set(activeTabIdAtom, initOpts.tabId);
    await GlobalModel.getInstance().initialize(globalInitOpts);
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;

    // Init WPS event handlers
    const globalWS = initWshrpc(makeTabRouteId(initOpts.tabId));
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;

    // ensures client/window/workspace are loaded into the cache before rendering
    try {
        await loadConnStatus();
        await loadBadges();
        initGlobalWaveEventSubs(initOpts);
        subscribeToConnEvents();
        if (isMacOS()) {
            const macOSVersion = await RpcApi.MacOSVersionCommand(TabRpcClient);
            setMacOSVersion(macOSVersion);
        }
        const [_client, waveWindow, initialTab] = await Promise.all([
            WOS.loadAndPinWaveObject<Client>(WOS.makeORef("client", initOpts.clientId)),
            WOS.loadAndPinWaveObject<WaveWindow>(WOS.makeORef("window", initOpts.windowId)),
            WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", initOpts.tabId)),
        ]);
        const [ws, _layoutState] = await Promise.all([
            WOS.loadAndPinWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid)),
            WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", initialTab.layoutstate)),
        ]);
        loadAllWorkspaceTabs(ws);
        WOS.wpsSubscribeToObject(WOS.makeORef("workspace", waveWindow.workspaceid));
        // nexus: sin esto los guards R1 y el menú espacial de la ventana
        // principal quedan ciegos (el modelo solo arrancaba en initSurface)
        SpatialModel.getInstance().start(waveWindow.workspaceid);
        document.title = `Nexus Workbench - ${initialTab.name}`; // TODO update with tab name change
    } catch (e) {
        console.error("Failed initialization error", e);
        getApi().sendLog("Error in initialization (wave.ts, loading required objects) " + e.message + "\n" + e.stack);
    }
    registerGlobalKeys();
    registerElectronReinjectKeyHandler();
    registerControlShiftStateUpdateHandler();
    await loadMonaco();
    const fullConfig = await RpcApi.GetFullConfigCommand(TabRpcClient);
    console.log("fullconfig", fullConfig);
    globalStore.set(atoms.fullConfigAtom, fullConfig);
    const waveaiModeConfig = await RpcApi.GetWaveAIModeConfigCommand(TabRpcClient);
    globalStore.set(atoms.waveaiModeConfigAtom, waveaiModeConfig.configs);
    console.log("Wave First Render");
    let firstRenderResolveFn: () => void = null;
    const firstRenderPromise = new Promise<void>((resolve) => {
        firstRenderResolveFn = resolve;
    });
    const reactElem = createElement(App, { onFirstRender: firstRenderResolveFn }, null);
    const elem = document.getElementById("main");
    const root = createRoot(elem);
    root.render(reactElem);
    await firstRenderPromise;
    console.log("Wave First Render Done");
    getApi().setWindowInitStatus("wave-ready");
}

// nexus: bootstrap de ventana spatial desacoplada (CONTRACTS §5) — sin LayoutModel
let savedSurfaceInitOpts: SpatialInitOpts = null;

async function initSurfaceWrap(initOpts: SpatialInitOpts) {
    try {
        if (savedSurfaceInitOpts != null) {
            return;
        }
        savedSurfaceInitOpts = initOpts;
        await initSurface(initOpts);
    } catch (e) {
        getApi().sendLog("Error in initSurface " + e.message + "\n" + e.stack);
        console.error("Error in initSurface", e);
    } finally {
        document.body.style.visibility = null;
        document.body.style.opacity = null;
        document.body.classList.remove("is-transparent");
    }
}

async function initSurface(initOpts: SpatialInitOpts) {
    getApi().sendLog("Init Surface " + JSON.stringify(initOpts));
    const globalInitOpts: GlobalInitOptions = {
        tabId: initOpts.tabId,
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        platform,
        environment: "renderer",
    };
    console.log("Surface Init", globalInitOpts);
    globalStore.set(activeTabIdAtom, initOpts.tabId);
    await GlobalModel.getInstance().initialize(globalInitOpts);
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;

    const globalWS = initWshrpc(makeSurfaceRouteId(initOpts.surfaceId));
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;

    try {
        await loadConnStatus();
        initGlobalWaveEventSubs({
            tabId: initOpts.tabId,
            clientId: initOpts.clientId,
            windowId: initOpts.windowId,
            activate: false,
        });
        subscribeToConnEvents();
        if (isMacOS()) {
            const macOSVersion = await RpcApi.MacOSVersionCommand(TabRpcClient);
            setMacOSVersion(macOSVersion);
        }
        // el windowId es sintético (sin waveobj window): solo se cargan
        // client, tab del módulo y workspace
        const [_client, surfaceTab] = await Promise.all([
            WOS.loadAndPinWaveObject<Client>(WOS.makeORef("client", initOpts.clientId)),
            WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", initOpts.tabId)),
        ]);
        await WOS.loadAndPinWaveObject<Workspace>(WOS.makeORef("workspace", initOpts.workspaceId));
        WOS.wpsSubscribeToObject(WOS.makeORef("workspace", initOpts.workspaceId));
        document.title = `Nexus Workbench - ${surfaceTab?.name ?? "Módulo"}`;
    } catch (e) {
        console.error("Failed surface initialization error", e);
        getApi().sendLog("Error in initialization (wave.ts, initSurface) " + e.message + "\n" + e.stack);
    }
    SpatialModel.getInstance().start(initOpts.workspaceId);
    registerElectronReinjectKeyHandler();
    registerControlShiftStateUpdateHandler();
    await loadMonaco();
    const fullConfig = await RpcApi.GetFullConfigCommand(TabRpcClient);
    globalStore.set(atoms.fullConfigAtom, fullConfig);
    const waveaiModeConfig = await RpcApi.GetWaveAIModeConfigCommand(TabRpcClient);
    globalStore.set(atoms.waveaiModeConfigAtom, waveaiModeConfig.configs);
    console.log("Surface First Render");
    let firstRenderResolveFn: () => void = null;
    const firstRenderPromise = new Promise<void>((resolve) => {
        firstRenderResolveFn = resolve;
    });
    const reactElem = createElement(SurfaceApp, { opts: initOpts, onFirstRender: firstRenderResolveFn }, null);
    const elem = document.getElementById("main");
    const root = createRoot(elem);
    root.render(reactElem);
    await firstRenderPromise;
    console.log("Surface First Render Done");
}

async function initBuilderWrap(initOpts: BuilderInitOpts) {
    try {
        await initBuilder(initOpts);
    } catch (e) {
        getApi().sendLog("Error in initBuilder " + e.message + "\n" + e.stack);
        console.error("Error in initBuilder", e);
    } finally {
        document.body.style.visibility = null;
        document.body.style.opacity = null;
        document.body.classList.remove("is-transparent");
    }
}

async function initBuilder(initOpts: BuilderInitOpts) {
    getApi().sendLog("Init Builder " + JSON.stringify(initOpts));
    const globalInitOpts: GlobalInitOptions = {
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        platform,
        environment: "renderer",
        builderId: initOpts.builderId,
    };
    console.log("Tsunami Builder Init", globalInitOpts);
    await GlobalModel.getInstance().initialize(globalInitOpts);
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;

    const globalWS = initWshrpc(makeBuilderRouteId(initOpts.builderId));
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;
    await loadConnStatus();

    let appIdToUse: string = null;
    try {
        const oref = WOS.makeORef("builder", initOpts.builderId);
        const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, { oref });
        if (rtInfo && rtInfo["builder:appid"]) {
            appIdToUse = rtInfo["builder:appid"];
        }
    } catch (e) {
        console.log("Could not load saved builder appId from rtinfo:", e);
    }

    document.title = appIdToUse ? `WaveApp Builder (${appIdToUse})` : "WaveApp Builder";

    globalStore.set(atoms.builderAppId, appIdToUse);

    const _client = await WOS.loadAndPinWaveObject<Client>(WOS.makeORef("client", initOpts.clientId));

    registerBuilderGlobalKeys();
    registerElectronReinjectKeyHandler();
    await loadMonaco();
    const fullConfig = await RpcApi.GetFullConfigCommand(TabRpcClient);
    console.log("fullconfig", fullConfig);
    globalStore.set(atoms.fullConfigAtom, fullConfig);
    const waveaiModeConfig = await RpcApi.GetWaveAIModeConfigCommand(TabRpcClient);
    globalStore.set(atoms.waveaiModeConfigAtom, waveaiModeConfig.configs);

    console.log("Tsunami Builder First Render");
    let firstRenderResolveFn: () => void = null;
    const firstRenderPromise = new Promise<void>((resolve) => {
        firstRenderResolveFn = resolve;
    });
    const reactElem = createElement(BuilderApp, { initOpts, onFirstRender: firstRenderResolveFn }, null);
    const elem = document.getElementById("main");
    const root = createRoot(elem);
    root.render(reactElem);
    await firstRenderPromise;
    console.log("Tsunami Builder First Render Done");
}
