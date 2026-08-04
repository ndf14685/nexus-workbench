// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { normalizeOrigin } from "@/app/nexus/permissions/permission-policy";
import type { SitePermissionRecord, WorkbenchPermission } from "@/app/nexus/permissions/permission-types";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { useEffect, useMemo, useState } from "react";

const PermissionLabels: Record<WorkbenchPermission, string> = {
    microphone: "Micrófono",
    camera: "Cámara",
    notifications: "Notificaciones",
    "display-capture": "Compartir pantalla",
};

const DecisionLabels = {
    allow: "Permitido",
    deny: "Preguntar nuevamente",
    ask: "Preguntar nuevamente",
    block: "Bloqueado",
};

function permissionSort(a: SitePermissionRecord, b: SitePermissionRecord) {
    return a.permission.localeCompare(b.permission) || a.origin.localeCompare(b.origin);
}

export function PermissionsSettings() {
    const env = useWaveEnv();
    const [records, setRecords] = useState<SitePermissionRecord[]>([]);
    const [filter, setFilter] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [newOrigin, setNewOrigin] = useState("");
    const [newPermission, setNewPermission] = useState<WorkbenchPermission>("microphone");

    const refresh = () => {
        env.electron
            .listSitePermissions()
            .then((next) => setRecords(next))
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    };

    useEffect(refresh, []);

    const filtered = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        if (!needle) {
            return [...records].sort(permissionSort);
        }
        return records
            .filter((rec) => `${rec.origin} ${PermissionLabels[rec.permission]} ${DecisionLabels[rec.decision]}`.toLowerCase().includes(needle))
            .sort(permissionSort);
    }, [records, filter]);

    const setDecision = async (rec: SitePermissionRecord, decision: SitePermissionRecord["decision"]) => {
        setError(null);
        const next = await env.electron.setSitePermission({ ...rec, decision, updatedAt: Date.now() });
        setRecords(next);
    };

    const revoke = async (rec: SitePermissionRecord) => {
        setError(null);
        const next = await env.electron.revokeSitePermission(rec.origin, rec.permission);
        setRecords(next);
    };

    const grantNewOrigin = async () => {
        setError(null);
        const raw = newOrigin.trim();
        const origin = normalizeOrigin(raw.includes("://") ? raw : `https://${raw}`);
        if (!origin) {
            setError("Ingresá un sitio válido, por ejemplo chatgpt.com o https://meet.google.com");
            return;
        }
        const next = await env.electron.setSitePermission({
            origin,
            permission: newPermission,
            decision: "allow",
            moduleId: "manual",
            updatedAt: Date.now(),
        });
        setRecords(next);
        setNewOrigin("");
    };

    const revokeAll = async (permission?: WorkbenchPermission) => {
        setError(null);
        const next = await env.electron.revokeAllSitePermissions(permission);
        setRecords(next);
    };

    return (
        <div className="flex flex-col h-full min-h-0 p-4 gap-4 overflow-auto">
            <div>
                <div className="text-lg font-semibold">Privacidad y permisos</div>
                <div className="text-sm text-muted mt-1">
                    Revisá, revocá o bloqueá permisos concedidos a sitios abiertos en módulos web.
                </div>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Buscar sitio o permiso"
                    className="bg-panel border border-border rounded px-3 py-1.5 text-sm min-w-64"
                />
                <button className="border border-border rounded px-3 py-1.5 text-sm hover:bg-hover" onClick={() => revokeAll()}>
                    Revocar todos
                </button>
                <button
                    className="border border-border rounded px-3 py-1.5 text-sm hover:bg-hover"
                    onClick={() => revokeAll("microphone")}
                >
                    Revocar micrófonos
                </button>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
                <input
                    value={newOrigin}
                    onChange={(e) => setNewOrigin(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && grantNewOrigin()}
                    placeholder="Conceder a un sitio (ej: chatgpt.com)"
                    className="bg-panel border border-border rounded px-3 py-1.5 text-sm min-w-64"
                />
                <select
                    value={newPermission}
                    onChange={(e) => setNewPermission(e.target.value as WorkbenchPermission)}
                    className="bg-panel border border-border rounded px-3 py-1.5 text-sm cursor-pointer"
                >
                    {Object.entries(PermissionLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                            {label}
                        </option>
                    ))}
                </select>
                <button
                    className="bg-accent/80 text-primary rounded px-3 py-1.5 text-sm hover:bg-accent transition-colors cursor-pointer"
                    onClick={grantNewOrigin}
                >
                    Permitir
                </button>
            </div>
            {error && <div className="text-error text-sm">{error}</div>}
            <div className="grid grid-cols-[1fr_140px_140px_260px] gap-2 text-xs text-muted uppercase border-b border-border pb-2">
                <div>Sitio</div>
                <div>Permiso</div>
                <div>Estado</div>
                <div>Acciones</div>
            </div>
            {filtered.length === 0 ? (
                <div className="text-sm text-muted">No hay permisos guardados.</div>
            ) : (
                filtered.map((rec) => (
                    <div
                        key={`${rec.origin}:${rec.permission}`}
                        className="grid grid-cols-[1fr_140px_140px_260px] gap-2 items-center py-2 border-b border-border/60 text-sm"
                    >
                        <div className="min-w-0">
                            <div className="truncate font-mono">{rec.origin}</div>
                            {rec.moduleId && <div className="text-xs text-muted truncate">Módulo: {rec.moduleId}</div>}
                        </div>
                        <div>{PermissionLabels[rec.permission]}</div>
                        <div>{DecisionLabels[rec.decision]}</div>
                        <div className="flex gap-2">
                            <button className="border border-border rounded px-2 py-1 hover:bg-hover" onClick={() => revoke(rec)}>
                                Preguntar
                            </button>
                            <button className="border border-border rounded px-2 py-1 hover:bg-hover" onClick={() => setDecision(rec, "block")}>
                                Bloquear
                            </button>
                            <button className="border border-border rounded px-2 py-1 hover:bg-hover" onClick={() => setDecision(rec, "allow")}>
                                Permitir
                            </button>
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
