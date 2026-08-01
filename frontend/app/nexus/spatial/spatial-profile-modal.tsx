// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { Modal } from "@/app/modals/modal";
import { modalsModel } from "@/store/modalmodel";
import { memo, useState } from "react";
import { saveProfileAs } from "./spatial-menu";

// El modal userinput de Wave es estrictamente backend-driven (requestid +
// UserInputService + timeout), así que el guardado de perfiles usa este
// modal mínimo propio (patrón modalsModel, ver RenameFileModal).
const SpatialSaveProfileModal = memo(() => {
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const handleSave = async () => {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        setSaving(true);
        try {
            await saveProfileAs(trimmed);
            modalsModel.popModal();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    const handleClose = () => {
        modalsModel.popModal();
    };

    return (
        <Modal
            className="p-4 min-w-[400px]"
            onOk={handleSave}
            onCancel={handleClose}
            onClose={handleClose}
            okLabel="Guardar"
            cancelLabel="Cancelar"
            okDisabled={saving || !name.trim()}
        >
            <div className="flex flex-col gap-4 mb-4">
                <h2 className="text-xl font-semibold">Guardar perfil</h2>
                <div className="flex flex-col gap-2">
                    <input
                        type="text"
                        placeholder="trabajo"
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value);
                            setError("");
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim() && !error) {
                                handleSave();
                            }
                        }}
                        className="px-3 py-2 bg-panel border border-border rounded focus:outline-none focus:border-accent"
                        autoFocus
                        disabled={saving}
                        spellCheck={false}
                    />
                    {error && <div className="text-sm text-error">{error}</div>}
                </div>
            </div>
        </Modal>
    );
});

SpatialSaveProfileModal.displayName = "SpatialSaveProfileModal";

export { SpatialSaveProfileModal };
