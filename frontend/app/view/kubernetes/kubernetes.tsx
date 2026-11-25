// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";
import { WOS } from "@/store/global";
import { makeConnRoute } from "@/util/util";
import clsx from "clsx";
import * as jotai from "jotai";
import * as React from "react";

type KubernetesEnv = WaveEnvSubset<{
    rpc: {
        RemoteKubeOverviewCommand: WaveEnv["rpc"]["RemoteKubeOverviewCommand"];
        RemoteKubeLogsCommand: WaveEnv["rpc"]["RemoteKubeLogsCommand"];
    };
}>;

export class KubernetesViewModel implements ViewModel {
    viewType = "kubernetes";
    blockId: string;
    env: KubernetesEnv;
    viewIcon = jotai.atom("dharmachakra");
    viewName = jotai.atom("Kubernetes");
    manageConnection = jotai.atom(true);
    noPadding = jotai.atom(true);

    constructor({ blockId, waveEnv }: ViewModelInitType) {
        this.blockId = blockId;
        this.env = waveEnv;
    }

    get viewComponent(): ViewComponent {
        return KubernetesView;
    }
}

function statusTone(status: string): string {
    const normalized = status?.toLowerCase();
    if (["running", "ready", "normal", "completed", "succeeded"].includes(normalized)) return "text-green-400";
    if (["pending", "unknown"].includes(normalized)) return "text-yellow-400";
    if (normalized) return "text-red-400";
    return "text-muted";
}

function KubernetesView({ blockId, model }: ViewComponentProps<KubernetesViewModel>) {
    const [blockData] = WOS.useWaveObjectValue<Block>(WOS.makeORef("block", blockId));
    const connection = blockData?.meta?.connection || "local";
    const route = React.useMemo(() => makeConnRoute(connection), [connection]);
    const [overview, setOverview] = React.useState<KubeOverview | null>(null);
    const [contextName, setContextName] = React.useState("");
    const [namespace, setNamespace] = React.useState("");
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState("");
    const [logs, setLogs] = React.useState<{ title: string; text: string } | null>(null);

    const refresh = React.useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const next = await model.env.rpc.RemoteKubeOverviewCommand(
                TabRpcClient,
                { context: contextName, namespace },
                { route, timeout: 20_000 }
            );
            setOverview(next);
            if (!contextName && next.currentcontext) setContextName(next.currentcontext);
        } catch (reason) {
            setError(String(reason));
        } finally {
            setLoading(false);
        }
    }, [contextName, namespace, model, route]);

    React.useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(), 15_000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const showLogs = async (resource: KubeResource) => {
        if (resource.kind !== "Pod" || !resource.namespace) return;
        setLogs({ title: `${resource.namespace}/${resource.name}`, text: "Loading logs…" });
        try {
            const text = await model.env.rpc.RemoteKubeLogsCommand(
                TabRpcClient,
                { context: contextName, namespace: resource.namespace, pod: resource.name, taillines: 300 },
                { route, timeout: 20_000 }
            );
            setLogs({ title: `${resource.namespace}/${resource.name}`, text: text || "No log output." });
        } catch (reason) {
            setLogs({ title: `${resource.namespace}/${resource.name}`, text: String(reason) });
        }
    };

    if (!loading && overview && !overview.available) {
        return (
            <section className="flex h-full items-center justify-center p-8" aria-label="Kubernetes explorer">
                <div className="max-w-md rounded border border-border bg-panel p-6 text-center">
                    <i className="fa fa-solid fa-dharmachakra mb-3 text-4xl text-muted" aria-hidden="true" />
                    <h2 className="mb-2 text-base font-semibold">Kubernetes not detected</h2>
                    <p className="text-sm text-muted">
                        Install kubectl and configure a kubeconfig on {connection} to activate this view.
                    </p>
                </div>
            </section>
        );
    }

    const resources = overview?.resources ?? [];
    const unhealthy = resources.filter(
        (resource) => !["Running", "Ready", "Completed", "Succeeded"].includes(resource.status)
    ).length;

    return (
        <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Kubernetes explorer">
            <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <i className="fa fa-solid fa-dharmachakra text-sky-400" aria-hidden="true" />
                <select
                    className="min-w-40 rounded border border-border bg-main px-2 py-1 text-xs"
                    aria-label="Kubernetes context"
                    value={contextName}
                    onChange={(event) => setContextName(event.target.value)}
                >
                    {(overview?.contexts ?? []).map((item) => (
                        <option key={item} value={item}>
                            {item}
                        </option>
                    ))}
                </select>
                <select
                    className="min-w-32 rounded border border-border bg-main px-2 py-1 text-xs"
                    aria-label="Kubernetes namespace"
                    value={namespace}
                    onChange={(event) => setNamespace(event.target.value)}
                >
                    <option value="">All namespaces</option>
                    {(overview?.namespaces ?? []).map((item) => (
                        <option key={item} value={item}>
                            {item}
                        </option>
                    ))}
                </select>
                <span
                    className={clsx(
                        "rounded px-2 py-1 text-xs",
                        unhealthy ? "bg-red-950 text-red-200" : "bg-green-950 text-green-200"
                    )}
                >
                    {unhealthy ? `${unhealthy} need attention` : "Healthy"}
                </span>
                <button
                    type="button"
                    className="ml-auto rounded px-2 py-1 text-xs hover:bg-hoverbg"
                    onClick={() => void refresh()}
                    disabled={loading}
                    aria-label="Refresh Kubernetes resources"
                >
                    <i className={clsx("fa fa-solid fa-arrows-rotate", loading && "fa-spin")} />
                </button>
            </header>
            {error && (
                <div role="alert" className="m-3 rounded border border-error p-3 text-xs text-error">
                    {error}
                </div>
            )}
            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
                <div className="min-h-0 overflow-auto border-r border-border">
                    <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 z-10 bg-panel text-muted">
                            <tr>
                                <th className="px-3 py-2">Kind</th>
                                <th className="px-3 py-2">Namespace</th>
                                <th className="px-3 py-2">Name</th>
                                <th className="px-3 py-2">Ready</th>
                                <th className="px-3 py-2">Status</th>
                                <th className="px-3 py-2">Restarts</th>
                                <th className="px-3 py-2">Age</th>
                            </tr>
                        </thead>
                        <tbody>
                            {resources.map((resource) => (
                                <tr
                                    key={`${resource.kind}:${resource.namespace}:${resource.name}`}
                                    className={clsx(
                                        "border-t border-border",
                                        resource.kind === "Pod" && "cursor-pointer hover:bg-hoverbg"
                                    )}
                                    onClick={() => void showLogs(resource)}
                                    tabIndex={resource.kind === "Pod" ? 0 : undefined}
                                    onKeyDown={(event) => {
                                        if (resource.kind === "Pod" && (event.key === "Enter" || event.key === " "))
                                            void showLogs(resource);
                                    }}
                                >
                                    <td className="px-3 py-2">{resource.kind}</td>
                                    <td className="px-3 py-2 text-muted">{resource.namespace}</td>
                                    <td className="px-3 py-2 font-mono">{resource.name}</td>
                                    <td className="px-3 py-2">{resource.ready || "—"}</td>
                                    <td className={clsx("px-3 py-2", statusTone(resource.status))}>
                                        {resource.status || "—"}
                                    </td>
                                    <td className="px-3 py-2">{resource.restarts || 0}</td>
                                    <td className="px-3 py-2">{resource.age || "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {!loading && resources.length === 0 && (
                        <div className="p-6 text-center text-sm text-muted">No resources found.</div>
                    )}
                </div>
                <aside className="min-h-0 overflow-auto p-3" aria-label="Kubernetes events and logs">
                    {logs ? (
                        <>
                            <div className="mb-2 flex items-center gap-2">
                                <strong className="min-w-0 flex-1 truncate text-xs">Logs: {logs.title}</strong>
                                <button
                                    type="button"
                                    className="rounded px-2 py-1 text-xs hover:bg-hoverbg"
                                    onClick={() => setLogs(null)}
                                    aria-label="Close logs"
                                >
                                    ×
                                </button>
                            </div>
                            <pre
                                className="max-h-full overflow-auto whitespace-pre-wrap break-words rounded bg-black/35 p-3 text-[11px] leading-4"
                                tabIndex={0}
                            >
                                {logs.text}
                            </pre>
                        </>
                    ) : (
                        <>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                                Recent events
                            </h3>
                            <div className="space-y-2">
                                {(overview?.events ?? [])
                                    .slice()
                                    .reverse()
                                    .map((event, index) => (
                                        <article
                                            key={`${event.namespace}:${event.name}:${index}`}
                                            className="rounded border border-border p-2 text-xs"
                                        >
                                            <div className="mb-1 flex gap-2">
                                                <span className={statusTone(event.status)}>{event.status}</span>
                                                <span className="truncate font-mono">
                                                    {event.namespace}/{event.name}
                                                </span>
                                            </div>
                                            <p className="text-muted">{event.message}</p>
                                        </article>
                                    ))}
                                {(overview?.events?.length ?? 0) === 0 && (
                                    <p className="text-xs text-muted">No recent events.</p>
                                )}
                            </div>
                        </>
                    )}
                </aside>
            </div>
        </section>
    );
}
