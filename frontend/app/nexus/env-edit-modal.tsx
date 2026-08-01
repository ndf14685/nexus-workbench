// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Administrador de servidores: alta/edición de un ambiente en un solo formulario
// compacto (sin pestañas ni asistente). Es el camino primario del catálogo; el
// importador YAML queda como bootstrap opcional.

import { Modal } from "@/app/modals/modal";
import { atoms, getSettingsKeyAtom } from "@/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/store/modalmodel";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useState } from "react";
import { canonicalizeConnName } from "./conn-name";
import {
    EnvAuthMethod,
    EnvFormErrors,
    EnvFormValues,
    envFromForm,
    hasErrors,
    passwordPlanForSave,
    persistEnv,
    removeEnv,
    slugifyEnvId,
    uniqueEnvId,
    validateEnvForm,
} from "./env-store";

export const StoredPasswordPlaceholder = "••••• (guardada)";

const AuthLabels: Record<EnvAuthMethod, string> = {
    key: "Clave",
    password: "Contraseña",
    agent: "Agente",
};

const InputClass =
    "px-3 py-1.5 bg-panel border border-border rounded focus:outline-none focus:border-accent text-sm w-full";

type FieldProps = {
    label: string;
    error?: string;
    children: React.ReactNode;
    hint?: string;
};

const Field = memo(({ label, error, children, hint }: FieldProps) => (
    <label className="flex flex-col gap-1 min-w-0">
        <span className="text-xxs uppercase tracking-wide text-secondary">{label}</span>
        {children}
        {hint && !error ? <span className="text-xxs text-muted">{hint}</span> : null}
        {error ? <span className="text-xxs text-error">{error}</span> : null}
    </label>
));
Field.displayName = "Field";

export type EnvEditModalProps = {
    form: EnvFormValues;
    isNew: boolean;
    hasStoredPassword?: boolean;
};

const EnvEditModal = memo(({ form: initialForm, isNew, hasStoredPassword }: EnvEditModalProps) => {
    const [form, setForm] = useState<EnvFormValues>(initialForm);
    const [errors, setErrors] = useState<EnvFormErrors>({});
    const [saveError, setSaveError] = useState("");
    const [saving, setSaving] = useState(false);
    const envs = useAtomValue(getSettingsKeyAtom("nexus:environments")) ?? [];

    const set = (patch: Partial<EnvFormValues>) => {
        setForm((f) => ({ ...f, ...patch }));
        setErrors({});
        setSaveError("");
    };

    const handleClose = () => modalsModel.popModal();

    const handleSave = () => {
        if (saving) {
            return;
        }
        const found = validateEnvForm(form);
        const envId =
            form.id !== ""
                ? form.id
                : uniqueEnvId(
                      slugifyEnvId(form.name),
                      envs.map((e) => e?.id)
                  );
        const plan = passwordPlanForSave({
            envId,
            auth: form.auth,
            password: form.password,
            hasStoredPassword: !!hasStoredPassword,
        });
        if (plan.error) {
            found.password = plan.error;
        }
        if (hasErrors(found)) {
            setErrors(found);
            return;
        }
        setSaving(true);
        const env = envFromForm({ ...form, id: envId });
        persistEnv({ envs, env, password: plan.password, secretName: plan.secretName })
            .then(() => modalsModel.popModal())
            .catch((err) => {
                setSaveError(err instanceof Error ? err.message : String(err));
                setSaving(false);
            });
    };

    const isSsh = form.kind === "ssh";
    const isWsl = form.kind === "wsl";
    const hostLabel = isWsl ? "Distro" : "Host";
    const conn = canonicalizeConnName(envFromForm(form).conn ?? "");

    return (
        <Modal
            className="p-4 w-[560px] max-w-[90vw]"
            onOk={handleSave}
            onCancel={handleClose}
            onClose={handleClose}
            okLabel={saving ? "Guardando…" : "Guardar"}
            cancelLabel="Cancelar"
            okDisabled={saving}
        >
            <div
                className="flex flex-col gap-3 mb-4"
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName !== "TEXTAREA") {
                        e.preventDefault();
                        handleSave();
                    }
                    if (e.key === "Escape") {
                        e.preventDefault();
                        handleClose();
                    }
                }}
            >
                <h2 className="text-lg font-semibold">{isNew ? "Nuevo servidor" : "Editar servidor"}</h2>

                <div className="grid grid-cols-2 gap-3">
                    <Field label="Nombre" error={errors.name}>
                        <input
                            className={InputClass}
                            value={form.name}
                            onChange={(e) => set({ name: e.target.value })}
                            placeholder="rig3060"
                            autoFocus
                            spellCheck={false}
                        />
                    </Field>
                    <Field label={hostLabel} error={errors.host} hint={isSsh ? "alias de ~/.ssh/config, o host" : null}>
                        <input
                            className={InputClass}
                            value={form.host}
                            onChange={(e) => set({ host: e.target.value })}
                            placeholder={isWsl ? "Ubuntu" : "192.168.50.105"}
                            spellCheck={false}
                        />
                    </Field>
                </div>

                {isSsh && (
                    <>
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Puerto" error={errors.port}>
                                <input
                                    className={InputClass}
                                    value={form.port}
                                    onChange={(e) => set({ port: e.target.value })}
                                    placeholder="22"
                                    spellCheck={false}
                                />
                            </Field>
                            <Field
                                label="Usuario"
                                hint="sin esto, en Windows se manda MAQUINA\usuario y falla el login"
                            >
                                <input
                                    className={InputClass}
                                    value={form.user}
                                    onChange={(e) => set({ user: e.target.value })}
                                    placeholder="ndf"
                                    spellCheck={false}
                                />
                            </Field>
                        </div>

                        <Field label="Método de autenticación">
                            <div className="flex gap-2">
                                {(["key", "password", "agent"] as EnvAuthMethod[]).map((m) => (
                                    <button
                                        key={m}
                                        type="button"
                                        className={cn(
                                            "px-3 py-1 rounded text-sm cursor-pointer border transition-colors",
                                            form.auth === m
                                                ? "bg-accent/80 text-primary border-accent"
                                                : "border-border text-secondary hover:bg-hoverbg"
                                        )}
                                        onClick={() => set({ auth: m })}
                                    >
                                        {AuthLabels[m]}
                                    </button>
                                ))}
                            </div>
                        </Field>

                        {form.auth === "key" && (
                            <Field label="Clave privada" error={errors.identityfile}>
                                <input
                                    className={InputClass}
                                    value={form.identityfile}
                                    onChange={(e) => set({ identityfile: e.target.value })}
                                    placeholder="~/.ssh/id_ed25519"
                                    spellCheck={false}
                                />
                            </Field>
                        )}

                        {form.auth === "password" && (
                            <Field
                                label="Contraseña"
                                error={errors.password}
                                hint="se guarda cifrada en el almacén de credenciales del SO, nunca en la configuración"
                            >
                                <input
                                    className={InputClass}
                                    type="password"
                                    value={form.password}
                                    onChange={(e) => set({ password: e.target.value })}
                                    placeholder={hasStoredPassword ? StoredPasswordPlaceholder : ""}
                                    spellCheck={false}
                                />
                            </Field>
                        )}
                    </>
                )}

                <div className="grid grid-cols-2 gap-3">
                    <Field label="Descripción">
                        <input
                            className={InputClass}
                            value={form.description}
                            onChange={(e) => set({ description: e.target.value })}
                            placeholder="opcional"
                            spellCheck={false}
                        />
                    </Field>
                    <Field label="Grupo">
                        <input
                            className={InputClass}
                            value={form.group}
                            onChange={(e) => set({ group: e.target.value })}
                            placeholder="Servidores"
                            spellCheck={false}
                        />
                    </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <Field label="Color">
                        <input
                            className={InputClass}
                            value={form.color}
                            onChange={(e) => set({ color: e.target.value })}
                            placeholder="#58a6ff"
                            spellCheck={false}
                        />
                    </Field>
                    <Field label="Ícono">
                        <input
                            className={InputClass}
                            value={form.icon}
                            onChange={(e) => set({ icon: e.target.value })}
                            placeholder="server"
                            spellCheck={false}
                        />
                    </Field>
                </div>

                <Field label="Comando inicial (opcional)">
                    <input
                        className={InputClass}
                        value={form.initscript}
                        onChange={(e) => set({ initscript: e.target.value })}
                        placeholder="cd /srv && tmux attach"
                        spellCheck={false}
                    />
                </Field>

                <label className="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        className="cursor-pointer"
                        checked={form.wsh}
                        onChange={(e) => set({ wsh: e.target.checked })}
                    />
                    <span className="text-sm">
                        Integración wsh (scrollback persistente); desactivá para shell plano tipo WinSSHTerm
                    </span>
                </label>

                {conn ? <div className="text-xxs text-muted">Conexión: {conn}</div> : null}
                {saveError ? <div className="text-sm text-error">{saveError}</div> : null}
            </div>
        </Modal>
    );
});
EnvEditModal.displayName = "EnvEditModal";

export type EnvDeleteModalProps = {
    env: NexusEnvType;
};

const EnvDeleteModal = memo(({ env }: EnvDeleteModalProps) => {
    const [error, setError] = useState("");
    const [deleting, setDeleting] = useState(false);
    const envs = useAtomValue(getSettingsKeyAtom("nexus:environments")) ?? [];

    const handleClose = () => modalsModel.popModal();

    const handleDelete = () => {
        if (deleting) {
            return;
        }
        setDeleting(true);
        removeEnv(envs, env.id)
            .then(() => modalsModel.popModal())
            .catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
                setDeleting(false);
            });
    };

    return (
        <Modal
            className="p-4 min-w-[400px] max-w-[90vw]"
            onOk={handleDelete}
            onCancel={handleClose}
            onClose={handleClose}
            okLabel={deleting ? "Eliminando…" : "Eliminar"}
            cancelLabel="Cancelar"
            okDisabled={deleting}
        >
            <div
                className="flex flex-col gap-3 mb-4"
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        handleClose();
                    }
                }}
            >
                <h2 className="text-lg font-semibold">Eliminar servidor</h2>
                <div className="text-sm">
                    ¿Eliminar <span className="font-semibold">{env.name ?? env.id}</span> del catálogo? También se borra
                    su contraseña guardada.
                </div>
                {error ? <div className="text-sm text-error">{error}</div> : null}
            </div>
        </Modal>
    );
});
EnvDeleteModal.displayName = "EnvDeleteModal";

// El método de autenticación no vive en el catálogo: lo dice connections.json
// (ssh:passwordsecretname). Se lee acá para que el modal abra con el método
// correcto y muestre el placeholder de contraseña guardada.
export function connEntryForConn(conn: string): ConnKeywords {
    const canon = canonicalizeConnName(conn ?? "");
    if (canon === "") {
        return null;
    }
    return globalStore.get(atoms.fullConfigAtom)?.connections?.[canon] ?? null;
}

export { EnvDeleteModal, EnvEditModal };
