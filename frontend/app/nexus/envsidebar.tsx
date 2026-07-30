// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { FocusManager } from "@/app/store/focusManager";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { Tooltip } from "@/element/tooltip";
import {
    atoms,
    createBlock,
    getConnStatusAtom,
    getSettingsKeyAtom,
    refocusNode,
    WOS,
} from "@/store/global";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { memo, useCallback, useRef } from "react";
import {
    clampSidebarWidth,
    colorForEnv,
    connStateForEnv,
    ConnStateColors,
    defaultIconForEnv,
    findEnvByConn,
    groupEnvironments,
    SidebarMaxWidth,
    SidebarMinWidth,
    toggleGroup,
} from "./envsidebar-util";

class EnvSidebarModel {
    private static instance: EnvSidebarModel = null;

    widthAtom: PrimitiveAtom<number>;
    collapsedAtom: PrimitiveAtom<boolean>;
    collapsedGroupsAtom: PrimitiveAtom<string[]>;
    selectedEnvAtom: PrimitiveAtom<string>;
    focusedEnvIdAtom!: Atom<string>;
    activeEnvIdAtom!: Atom<string>;

    private constructor() {
        this.widthAtom = atom(clampSidebarWidth(globalStore.get(getSettingsKeyAtom("nexus:sidebarwidth"))));
        this.collapsedAtom = atom(globalStore.get(getSettingsKeyAtom("nexus:sidebarcollapsed")) ?? false);
        this.collapsedGroupsAtom = atom(globalStore.get(getSettingsKeyAtom("nexus:sidebarcollapsedgroups")) ?? []);
        this.selectedEnvAtom = atom(globalStore.get(getSettingsKeyAtom("nexus:lastselectedenv")) ?? "");
        this.focusedEnvIdAtom = atom((get) => {
            const blockId = get(FocusManager.getInstance().blockFocusAtom);
            if (!blockId) {
                return null;
            }
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block == null) {
                return null;
            }
            const envs = get(getSettingsKeyAtom("nexus:environments")) ?? [];
            return findEnvByConn(envs, block.meta?.connection ?? "")?.id ?? null;
        });
        // The env of the focused block wins (sidebar follows tab/block focus);
        // the manually selected env is the fallback when focus is elsewhere.
        this.activeEnvIdAtom = atom((get) => get(this.focusedEnvIdAtom) ?? get(this.selectedEnvAtom));
    }

    static getInstance(): EnvSidebarModel {
        if (!EnvSidebarModel.instance) {
            EnvSidebarModel.instance = new EnvSidebarModel();
        }
        return EnvSidebarModel.instance;
    }

    persist(settings: SettingsType) {
        fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, settings));
    }

    setWidth(width: number, persist: boolean) {
        const clamped = clampSidebarWidth(width);
        globalStore.set(this.widthAtom, clamped);
        if (persist) {
            this.persist({ "nexus:sidebarwidth": clamped });
        }
    }

    toggleCollapsed() {
        const next = !globalStore.get(this.collapsedAtom);
        globalStore.set(this.collapsedAtom, next);
        this.persist({ "nexus:sidebarcollapsed": next });
    }

    toggleGroupCollapsed(title: string) {
        const next = toggleGroup(globalStore.get(this.collapsedGroupsAtom), title);
        globalStore.set(this.collapsedGroupsAtom, next);
        this.persist({ "nexus:sidebarcollapsedgroups": next });
    }

    selectEnv(envId: string) {
        globalStore.set(this.selectedEnvAtom, envId);
        this.persist({ "nexus:lastselectedenv": envId });
    }

    findOpenBlockForEnv(env: NexusEnvType): string {
        const tabId = globalStore.get(atoms.staticTabId);
        if (!tabId) {
            return null;
        }
        const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        for (const blockId of tab?.blockids ?? []) {
            const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && (block.meta?.connection ?? "") === (env.conn ?? "")) {
                return blockId;
            }
        }
        return null;
    }

    openEnv(env: NexusEnvType) {
        this.selectEnv(env.id);
        const existingBlockId = this.findOpenBlockForEnv(env);
        if (existingBlockId != null) {
            refocusNode(existingBlockId);
            return;
        }
        const meta: MetaType = { view: "term", controller: "shell" };
        if (env.conn) {
            meta.connection = env.conn;
        }
        fireAndForget(() => createBlock({ meta }));
    }
}

function envContextMenu(model: EnvSidebarModel, env: NexusEnvType, connState: string): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [
        { label: "Abrir terminal", click: () => model.openEnv(env) },
    ];
    if (env.conn) {
        if (connState !== "connected") {
            menu.push({
                label: "Conectar",
                click: () => fireAndForget(() => RpcApi.ConnConnectCommand(TabRpcClient, { host: env.conn })),
            });
        } else {
            menu.push({
                label: "Reconectar",
                click: () =>
                    fireAndForget(async () => {
                        await RpcApi.ConnDisconnectCommand(TabRpcClient, env.conn);
                        await RpcApi.ConnConnectCommand(TabRpcClient, { host: env.conn });
                    }),
            });
            menu.push({
                label: "Desconectar",
                click: () => fireAndForget(() => RpcApi.ConnDisconnectCommand(TabRpcClient, env.conn)),
            });
        }
        menu.push({ type: "separator" });
        menu.push({
            label: "Copiar host",
            click: () => fireAndForget(() => navigator.clipboard.writeText(env.conn)),
        });
    }
    menu.push({ type: "separator" });
    menu.push({
        label: "Editar catálogo (settings.json)",
        click: () => fireAndForget(async () => void (await createBlock({ meta: { view: "waveconfig" } }, false, true))),
    });
    return menu;
}

type EnvItemProps = {
    env: NexusEnvType;
    active: boolean;
    collapsed: boolean;
};

const EnvItem = memo(({ env, active, collapsed }: EnvItemProps) => {
    const model = EnvSidebarModel.getInstance();
    const connStatus = useAtomValue(getConnStatusAtom(env.conn ?? ""));
    const connState = connStateForEnv(env, connStatus);
    const icon = env.icon ?? defaultIconForEnv(env);
    const color = colorForEnv(env);

    const handleContextMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            ContextMenuModel.getInstance().showContextMenu(envContextMenu(model, env, connState), e);
        },
        [env, connState]
    );

    const statusDot =
        connState === "none" ? null : (
            <span
                className={cn("w-2 h-2 rounded-full shrink-0", connState === "connecting" && "animate-pulse")}
                style={{ backgroundColor: ConnStateColors[connState] }}
                title={connState}
            />
        );

    const inner = collapsed ? (
        <button
            className={cn(
                "flex items-center justify-center w-full py-2 rounded-sm cursor-pointer text-lg",
                active ? "bg-hoverbg text-primary" : "text-secondary hover:bg-hoverbg hover:text-primary"
            )}
            style={{ color: active ? color : undefined }}
            onClick={() => model.selectEnv(env.id)}
            onDoubleClick={() => model.openEnv(env)}
            onKeyDown={(e) => e.key === "Enter" && model.openEnv(env)}
            onContextMenu={handleContextMenu}
            aria-current={active ? "true" : undefined}
            aria-label={env.name ?? env.id}
        >
            <i className={makeIconClass(icon, true, { defaultIcon: "circle-nodes" })} />
        </button>
    ) : (
        <button
            className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 rounded-sm cursor-pointer text-left border-l-2",
                active
                    ? "bg-hoverbg text-primary border-l-accent"
                    : "text-secondary hover:bg-hoverbg hover:text-primary border-l-transparent"
            )}
            onClick={() => model.selectEnv(env.id)}
            onDoubleClick={() => model.openEnv(env)}
            onKeyDown={(e) => e.key === "Enter" && model.openEnv(env)}
            onContextMenu={handleContextMenu}
            aria-current={active ? "true" : undefined}
        >
            <span className="text-base shrink-0 w-5 text-center" style={{ color }}>
                <i className={makeIconClass(icon, true, { defaultIcon: "circle-nodes" })} />
            </span>
            <span className="flex flex-col min-w-0 flex-1">
                <span className="text-sm truncate">{env.name ?? env.id}</span>
                {env.conn ? <span className="text-xxs text-muted truncate">{env.conn}</span> : null}
            </span>
            {statusDot}
        </button>
    );

    if (!collapsed) {
        return inner;
    }
    return (
        <Tooltip content={`${env.name ?? env.id}${env.conn ? ` (${env.conn})` : ""}`} placement="right">
            {inner}
        </Tooltip>
    );
});
EnvItem.displayName = "EnvItem";

const EnvSidebar = memo(() => {
    const model = EnvSidebarModel.getInstance();
    const envs = useAtomValue(getSettingsKeyAtom("nexus:environments"));
    const visible = useAtomValue(getSettingsKeyAtom("nexus:sidebarvisible")) ?? true;
    const width = useAtomValue(model.widthAtom);
    const collapsed = useAtomValue(model.collapsedAtom);
    const collapsedGroups = useAtomValue(model.collapsedGroupsAtom);
    const activeEnvId = useAtomValue(model.activeEnvIdAtom);
    const dragStateRef = useRef<{ startX: number; startWidth: number }>(null);

    const handleResizePointerDown = useCallback(
        (e: React.PointerEvent) => {
            dragStateRef.current = { startX: e.clientX, startWidth: globalStore.get(model.widthAtom) };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
        },
        [model]
    );
    const handleResizePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (dragStateRef.current == null) {
                return;
            }
            model.setWidth(dragStateRef.current.startWidth + (e.clientX - dragStateRef.current.startX), false);
        },
        [model]
    );
    const handleResizePointerUp = useCallback(
        (e: React.PointerEvent) => {
            if (dragStateRef.current == null) {
                return;
            }
            dragStateRef.current = null;
            model.setWidth(globalStore.get(model.widthAtom), true);
        },
        [model]
    );

    if (!visible || envs == null || envs.length === 0) {
        return null;
    }

    const groups = groupEnvironments(envs);

    return (
        <div
            className="flex flex-row h-full shrink-0 select-none border-r border-border"
            style={{ width: collapsed ? 48 : width }}
        >
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
                <div className={cn("flex items-center shrink-0 py-1", collapsed ? "justify-center" : "px-2 gap-1")}>
                    {!collapsed && (
                        <span className="text-xs font-semibold text-secondary uppercase tracking-wide flex-1 truncate">
                            Ambientes
                        </span>
                    )}
                    <Tooltip content={collapsed ? "Expandir ambientes" : "Colapsar a iconos"} placement="right">
                        <button
                            className="text-secondary hover:text-primary hover:bg-hoverbg rounded-sm px-1.5 py-0.5 cursor-pointer"
                            onClick={() => model.toggleCollapsed()}
                            aria-label={collapsed ? "Expandir sidebar de ambientes" : "Colapsar sidebar de ambientes"}
                        >
                            <i className={makeIconClass(collapsed ? "angles-right" : "angles-left", true)} />
                        </button>
                    </Tooltip>
                </div>
                <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden px-1 pb-1 gap-0.5">
                    {groups.map((group) => {
                        const groupCollapsed = collapsedGroups.includes(group.title);
                        return (
                            <div key={group.title} className="flex flex-col gap-0.5">
                                {!collapsed && (
                                    <button
                                        className="flex items-center gap-1 px-1 pt-2 pb-0.5 text-xxs text-muted uppercase tracking-wider cursor-pointer hover:text-secondary"
                                        onClick={() => model.toggleGroupCollapsed(group.title)}
                                        aria-expanded={!groupCollapsed}
                                    >
                                        <i
                                            className={makeIconClass(
                                                groupCollapsed ? "chevron-right" : "chevron-down",
                                                true
                                            )}
                                            style={{ fontSize: 9 }}
                                        />
                                        {group.title}
                                    </button>
                                )}
                                {(!groupCollapsed || collapsed) &&
                                    group.envs.map((env) => (
                                        <EnvItem
                                            key={env.id}
                                            env={env}
                                            active={env.id === activeEnvId}
                                            collapsed={collapsed}
                                        />
                                    ))}
                            </div>
                        );
                    })}
                </div>
            </div>
            {!collapsed && (
                <div
                    className="w-1 h-full cursor-col-resize hover:bg-zinc-500/30 transition-colors shrink-0"
                    onPointerDown={handleResizePointerDown}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Redimensionar sidebar de ambientes"
                />
            )}
        </div>
    );
});
EnvSidebar.displayName = "EnvSidebar";

export { EnvSidebar };
