// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { TreeNodeData, TreeView } from "@/app/treeview/treeview";
import { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { WOS } from "@/store/global";
import { formatRemoteUri } from "@/util/waveutil";
import * as jotai from "jotai";
import * as React from "react";

type WorkspaceExplorerEnv = WaveEnvSubset<{
    rpc: {
        FileInfoCommand: WaveEnv["rpc"]["FileInfoCommand"];
        FileListCommand: WaveEnv["rpc"]["FileListCommand"];
    };
    createBlock: WaveEnv["createBlock"];
}>;

export function joinWorkspacePath(parent: string, childName: string): string {
    if (!childName || childName === "." || childName === ".." || /[\\/]/.test(childName)) {
        throw new Error("Invalid child name");
    }
    const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    return `${parent.replace(/[\\/]$/, "")}${separator}${childName}`;
}

export function fileInfoToTreeNode(info: FileInfo): TreeNodeData {
    return {
        id: info.path,
        path: info.path,
        label: info.name || info.path,
        isDirectory: Boolean(info.isdir),
        mimeType: info.mimetype,
        isReadonly: Boolean(info.readonly),
        notfound: Boolean(info.notfound),
        staterror: info.staterror,
        childrenStatus: info.isdir ? "unloaded" : "loaded",
    };
}

export class WorkspaceExplorerViewModel implements ViewModel {
    viewType = "workspaceexplorer";
    blockId: string;
    env: WorkspaceExplorerEnv;
    viewIcon = jotai.atom("folder-tree");
    viewName = jotai.atom("Workspace");
    manageConnection = jotai.atom(true);
    noPadding = jotai.atom(true);

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.blockId = blockId;
        this.env = waveEnv;
    }

    get viewComponent(): ViewComponent {
        return WorkspaceExplorerView;
    }
}

function WorkspaceExplorerView({ blockId, model }: ViewComponentProps<WorkspaceExplorerViewModel>) {
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    const connection = blockData?.meta?.connection || "local";
    const configuredRoot = blockData?.meta?.file || blockData?.meta?.["cmd:cwd"] || "~";
    const [rootInfo, setRootInfo] = React.useState<FileInfo | null>(null);
    const [error, setError] = React.useState("");
    const [refreshVersion, setRefreshVersion] = React.useState(0);

    React.useEffect(() => {
        let cancelled = false;
        setError("");
        model.env.rpc
            .FileInfoCommand(TabRpcClient, { info: { path: formatRemoteUri(configuredRoot, connection) } })
            .then((info) => {
                if (!cancelled) setRootInfo(info);
            })
            .catch((reason) => {
                if (!cancelled) setError(String(reason));
            });
        return () => {
            cancelled = true;
        };
    }, [configuredRoot, connection, model, refreshVersion]);

    const initialNodes = React.useMemo(
        () => (rootInfo ? { [rootInfo.path]: fileInfoToTreeNode(rootInfo) } : {}),
        [rootInfo, refreshVersion]
    );

    const fetchDir = React.useCallback(
        async (path: string, limit: number) => {
            const entries = await model.env.rpc.FileListCommand(TabRpcClient, {
                path: formatRemoteUri(path, connection),
                opts: { limit, all: false },
            });
            return {
                nodes: entries.map(fileInfoToTreeNode),
                capped: entries.length >= limit,
                totalKnown: entries.length,
            };
        },
        [connection, model]
    );

    const openFile = React.useCallback(
        (_id: string, node: TreeNodeData) => {
            if (node.isDirectory) return;
            void model.env.createBlock({
                meta: { view: "preview", file: node.path, connection: connection === "local" ? null : connection },
            });
        },
        [connection, model]
    );

    const openTerminal = () => {
        void model.env.createBlock({
            meta: {
                view: "term",
                controller: "shell",
                "cmd:cwd": rootInfo?.path || configuredRoot,
                connection: connection === "local" ? null : connection,
            },
        });
    };

    return (
        <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Workspace file explorer">
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
                <strong className="min-w-0 flex-1 truncate text-xs" title={rootInfo?.path || configuredRoot}>
                    {rootInfo?.path || configuredRoot}
                </strong>
                <button
                    type="button"
                    className="rounded px-2 py-1 text-xs hover:bg-hoverbg"
                    onClick={openTerminal}
                    aria-label="Open terminal in workspace"
                    title="Open terminal here"
                >
                    <i className="fa fa-solid fa-square-terminal" />
                </button>
                <button
                    type="button"
                    className="rounded px-2 py-1 text-xs hover:bg-hoverbg"
                    onClick={() => setRefreshVersion((value) => value + 1)}
                    aria-label="Refresh workspace tree"
                    title="Refresh"
                >
                    <i className="fa fa-solid fa-arrows-rotate" />
                </button>
            </header>
            {error ? (
                <div role="alert" className="m-3 rounded border border-error p-3 text-xs text-error">
                    {error}
                </div>
            ) : rootInfo ? (
                <TreeView
                    key={`${rootInfo.path}:${refreshVersion}`}
                    rootIds={[rootInfo.path]}
                    initialNodes={initialNodes}
                    fetchDir={fetchDir}
                    width="100%"
                    height="100%"
                    maxWidth={Number.MAX_SAFE_INTEGER}
                    className="min-h-0 flex-1"
                    onOpenFile={openFile}
                />
            ) : (
                <div className="p-3 text-xs text-muted" role="status">
                    Loading workspace…
                </div>
            )}
        </section>
    );
}
