// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { modalsModel } from "@/app/store/modalmodel";
import {
    atoms,
    createBlock,
    createBlockSplitHorizontally,
    createBlockSplitVertically,
    getApi,
    getFocusedBlockId,
    globalStore,
    WOS,
} from "@/app/store/global";
import { getLayoutModelForStaticTab, NavigateDirection } from "@/layout/index";
import type { CommandDefinition } from "./command-types";
import { commandRegistry } from "./command-registry";

let registered = false;

const WebApps = {
    chatgpt: { title: "ChatGPT", url: "https://chatgpt.com/", partition: "persist:nexus-chatgpt" },
    claude: { title: "Claude Chat", url: "https://claude.ai/new", partition: "persist:nexus-claude" },
    antigravity: { title: "Antigravity Chat", url: "https://gemini.google.com/app", partition: "persist:nexus-antigravity" },
};

function notify(message: string) {
    modalsModel.pushModal("MessageModal", { children: message });
}

function focusedBlockData(): Block | null {
    const blockId = getFocusedBlockId();
    if (!blockId) return null;
    return globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId))) ?? null;
}

function openTerm(cmd?: string) {
    void createBlock({ meta: { view: "term", controller: "shell", ...(cmd ? { cmd } : {}) } });
    return true;
}

function openConfig(file?: string) {
    void createBlock({ meta: { view: "waveconfig", ...(file ? { file } : {}) } });
    return true;
}

function openWeb(url = "https://www.google.com/", title?: string, partition?: string) {
    void createBlock({ meta: { view: "web", url, ...(title ? { "frame:title": title } : {}), ...(partition ? { "web:partition": partition } : {}) } });
    return true;
}

function split(direction: "horizontal" | "vertical") {
    const layoutModel = getLayoutModelForStaticTab();
    const focused = globalStore.get(layoutModel.focusedNode);
    if (!focused) return false;
    const blockDef = { meta: { view: "term", controller: "shell" } };
    void (direction === "horizontal"
        ? createBlockSplitHorizontally(blockDef, focused.data.blockId, "after")
        : createBlockSplitVertically(blockDef, focused.data.blockId, "after"));
    return true;
}

function closeFocusedPanel() {
    const layoutModel = getLayoutModelForStaticTab();
    const focused = globalStore.get(layoutModel.focusedNode);
    if (!focused) return false;
    void layoutModel.closeNode(focused.id);
    return true;
}

function maximizeFocusedPanel() {
    const layoutModel = getLayoutModelForStaticTab();
    const focused = globalStore.get(layoutModel.focusedNode);
    if (!focused) return false;
    layoutModel.magnifyNodeToggle(focused.id);
    return true;
}

function switchTab(offset: number) {
    const ws = globalStore.get(atoms.workspace);
    const tabids = ws?.tabids ?? [];
    const cur = globalStore.get(atoms.staticTabId);
    const idx = tabids.indexOf(cur);
    if (idx < 0 || tabids.length === 0) return false;
    const next = tabids[(idx + offset + tabids.length) % tabids.length];
    getApi().setActiveTab(next);
    return true;
}

function switchTabAbs(index: number) {
    const ws = globalStore.get(atoms.workspace);
    const tabid = ws?.tabids?.[index - 1];
    if (!tabid) return false;
    getApi().setActiveTab(tabid);
    return true;
}

function reloadFocusedModule() {
    const block = focusedBlockData();
    if (block?.meta?.view === "web") {
        getApi().doRefresh();
        return true;
    }
    window.location.reload();
    return true;
}

function unavailable(title: string) {
    return () => {
        notify(`${title} no está disponible en este contexto.`);
        return false;
    };
}

function register(command: CommandDefinition) {
    try {
        commandRegistry.register(command);
    } catch (e) {
        if (!String(e).includes("already registered")) throw e;
    }
}

export function registerWorkbenchCommands() {
    if (registered) return;
    registered = true;

    const commands: CommandDefinition[] = [
        { id: "jarvis.open", title: "Invocar a Jarvis", description: "Delegar el contexto actual a Jarvis en lenguaje natural", category: "General", defaultShortcut: "Ctrl+Space", contexts: ["global"], editable: true, handler: () => { if (modalsModel.isModalOpen("JarvisOverlay")) { modalsModel.popModal(); } else { modalsModel.pushModal("JarvisOverlay", {}); } return true; } },
        { id: "workspace.openCommandPalette", title: "Abrir paleta de comandos", description: "Buscar y ejecutar comandos del Workbench", category: "General", defaultShortcut: "Ctrl+Shift+P", contexts: ["global"], editable: true, handler: () => modalsModel.pushModal("CommandPaletteModal") },
        { id: "workspace.openSettings", title: "Abrir configuración", description: "Abrir la configuración del Workbench", category: "General", defaultShortcut: "Ctrl+,", contexts: ["global"], editable: true, handler: () => openConfig() },
        { id: "workspace.openKeyboardShortcuts", title: "Abrir atajos de teclado", description: "Editar combinaciones de comandos", category: "General", defaultShortcut: "Ctrl+K Ctrl+S", contexts: ["global"], editable: true, handler: () => openConfig("nexus-shortcuts") },
        { id: "workspace.reloadActiveModule", title: "Recargar módulo activo", description: "Recargar el módulo o la app", category: "General", defaultShortcut: "Ctrl+Shift+R", contexts: ["global"], editable: true, handler: reloadFocusedModule },
        { id: "workspace.closeActiveModule", title: "Cerrar módulo o panel activo", description: "Cerrar el panel enfocado", category: "General", defaultShortcut: "Ctrl+Shift+W", contexts: ["global"], editable: true, handler: closeFocusedPanel },
        { id: "workspace.nextModule", title: "Ir al módulo siguiente", description: "Enfocar la pestaña siguiente", category: "General", defaultShortcut: "Ctrl+Tab", contexts: ["global"], editable: true, handler: () => switchTab(1) },
        { id: "workspace.previousModule", title: "Ir al módulo anterior", description: "Enfocar la pestaña anterior", category: "General", defaultShortcut: "Ctrl+Shift+Tab", contexts: ["global"], editable: true, handler: () => switchTab(-1) },
        { id: "workspace.toggleFullscreen", title: "Pantalla completa", description: "Activar o desactivar pantalla completa", category: "General", defaultShortcut: "F11", contexts: ["global"], editable: true, handler: () => getApi().toggleFullScreen() },
        { id: "module.openTerminal", title: "Abrir Terminal", description: "Crear una nueva terminal local", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+T", contexts: ["global"], editable: true, handler: () => openTerm() },
        { id: "module.openSshConnections", title: "Abrir conexiones SSH", description: "Abrir configuración de conexiones SSH", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+S", contexts: ["global"], editable: true, handler: () => openConfig("connections.json") },
        { id: "module.openBrowser", title: "Abrir navegador", description: "Crear un módulo web genérico", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+B", contexts: ["global"], editable: true, handler: () => openWeb() },
        { id: "module.openChatGPT", title: "Abrir ChatGPT", description: "Abrir ChatGPT como módulo web", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+G", contexts: ["global"], editable: true, handler: () => openWeb(WebApps.chatgpt.url, WebApps.chatgpt.title, WebApps.chatgpt.partition) },
        { id: "module.openClaudeChat", title: "Abrir Claude Chat", description: "Abrir Claude Chat como módulo web", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+C", contexts: ["global"], editable: true, handler: () => openWeb(WebApps.claude.url, WebApps.claude.title, WebApps.claude.partition) },
        { id: "module.openAntigravityChat", title: "Abrir Antigravity Chat", description: "Abrir Gemini, el chat web asociado al proveedor Antigravity/Agy", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+A", contexts: ["global"], editable: true, handler: () => openWeb(WebApps.antigravity.url, WebApps.antigravity.title, WebApps.antigravity.partition) },
        { id: "module.openCodexCli", title: "Abrir Codex CLI", description: "Abrir Codex en una terminal", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+X", contexts: ["global"], editable: true, handler: () => openTerm("codex") },
        { id: "module.openClaudeCli", title: "Abrir Claude CLI", description: "Abrir Claude Code en una terminal", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+L", contexts: ["global"], editable: true, handler: () => openTerm("claude") },
        { id: "module.openJarvis", title: "Abrir Jarvis", description: "Abrir el panel Jarvis Mission Supervisor", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+J", contexts: ["global"], editable: true, handler: () => { void createBlock({ meta: { view: "jarvis" } }); return true; } },
        { id: "module.openToday", title: "Abrir Hoy (cockpit de atención)", description: "Lo único que necesita de vos, lo que el sistema resolvió solo y lo que sigue en curso", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+H", contexts: ["global"], editable: true, handler: () => { void createBlock({ meta: { view: "operator" } }); return true; } },
        { id: "module.openFileExplorer", title: "Abrir explorador de archivos", description: "Abrir un panel de archivos del directorio actual", category: "Navegación y módulos", defaultShortcut: "Ctrl+Alt+E", contexts: ["global"], editable: true, handler: () => { void createBlock({ meta: { view: "preview" } }); return true; } },
        { id: "module.openAuditLog", title: "Abrir auditoría MCP", description: "Ver qué ejecutaron los agentes: ambiente, decisión y confirmaciones", category: "Seguridad", defaultShortcut: "Ctrl+Alt+U", contexts: ["global"], editable: true, handler: () => { void createBlock({ meta: { view: "nexusaudit" } }); return true; } },
        { id: "layout.splitVertical", title: "Dividir panel verticalmente", description: "Crear un panel a la derecha", category: "Layout", defaultShortcut: "Ctrl+Shift+\\", contexts: ["global"], editable: true, handler: () => split("vertical") },
        { id: "layout.splitHorizontal", title: "Dividir panel horizontalmente", description: "Crear un panel debajo", category: "Layout", defaultShortcut: "Ctrl+Shift+-", contexts: ["global"], editable: true, handler: () => split("horizontal") },
        { id: "layout.closePanel", title: "Cerrar panel activo", description: "Cerrar el panel enfocado", category: "Layout", defaultShortcut: "Ctrl+Shift+Q", contexts: ["global"], editable: true, handler: closeFocusedPanel },
        { id: "layout.toggleMaximizePanel", title: "Maximizar o restaurar panel activo", description: "Alternar maximización del panel", category: "Layout", defaultShortcut: "Ctrl+Shift+M", contexts: ["global"], editable: true, handler: maximizeFocusedPanel },
        { id: "layout.moveLeft", title: "Mover módulo al panel izquierdo", description: "Mover o enfocar hacia la izquierda", category: "Layout", defaultShortcut: "Ctrl+Shift+ArrowLeft", contexts: ["global"], editable: true, handler: () => { getLayoutModelForStaticTab().switchNodeFocusInDirection(NavigateDirection.Left, false); return true; } },
        { id: "layout.moveRight", title: "Mover módulo al panel derecho", description: "Mover o enfocar hacia la derecha", category: "Layout", defaultShortcut: "Ctrl+Shift+ArrowRight", contexts: ["global"], editable: true, handler: () => { getLayoutModelForStaticTab().switchNodeFocusInDirection(NavigateDirection.Right, false); return true; } },
        { id: "layout.moveUp", title: "Mover módulo arriba", description: "Mover o enfocar hacia arriba", category: "Layout", defaultShortcut: "Ctrl+Shift+ArrowUp", contexts: ["global"], editable: true, handler: () => { getLayoutModelForStaticTab().switchNodeFocusInDirection(NavigateDirection.Up, false); return true; } },
        { id: "layout.moveDown", title: "Mover módulo abajo", description: "Mover o enfocar hacia abajo", category: "Layout", defaultShortcut: "Ctrl+Shift+ArrowDown", contexts: ["global"], editable: true, handler: () => { getLayoutModelForStaticTab().switchNodeFocusInDirection(NavigateDirection.Down, false); return true; } },
        { id: "layout.sendToOtherWindow", title: "Enviar módulo a otra ventana o monitor", description: "Separar el módulo enfocado en otra ventana", category: "Layout", defaultShortcut: "Ctrl+Alt+M", contexts: ["global"], editable: true, handler: unavailable("Enviar módulo a otra ventana o monitor") },
        { id: "layout.recoverWindows", title: "Recuperar ventanas al monitor principal", description: "Reubicar ventanas perdidas", category: "Layout", defaultShortcut: "Ctrl+Alt+Home", contexts: ["global"], editable: true, handler: unavailable("Recuperar ventanas") },
        { id: "layout.saveCurrent", title: "Guardar layout actual", description: "Guardar el layout actual", category: "Layout", contexts: ["global"], editable: true, handler: unavailable("Guardar layout") },
        { id: "layout.restoreDefault", title: "Restaurar layout predeterminado", description: "Volver al layout por defecto", category: "Layout", contexts: ["global"], editable: true, handler: unavailable("Restaurar layout") },
        { id: "terminal.newTerminal", title: "Nueva terminal", description: "Crear una terminal", category: "Terminal", defaultShortcut: "Ctrl+Shift+T", contexts: ["terminal", "global"], editable: true, handler: () => openTerm() },
        { id: "terminal.newSession", title: "Nueva conexión o sesión", description: "Abrir selector de conexiones", category: "Terminal", defaultShortcut: "Ctrl+Shift+N", contexts: ["terminal"], editable: true, handler: () => openConfig("connections.json") },
        { id: "terminal.copySelection", title: "Copiar selección", description: "Copiar texto seleccionado en terminal", category: "Terminal", defaultShortcut: "Ctrl+Shift+C", contexts: ["terminal"], editable: true, handler: () => document.execCommand("copy") },
        { id: "terminal.paste", title: "Pegar", description: "Pegar en terminal", category: "Terminal", defaultShortcut: "Ctrl+Shift+V", contexts: ["terminal"], editable: true, handler: () => getApi().nativePaste() },
        { id: "terminal.find", title: "Buscar en terminal", description: "Abrir búsqueda del panel", category: "Terminal", defaultShortcut: "Ctrl+Shift+F", contexts: ["terminal"], editable: true, handler: unavailable("Buscar en terminal") },
        { id: "terminal.clear", title: "Limpiar terminal", description: "Limpiar la pantalla de terminal", category: "Terminal", defaultShortcut: "Ctrl+Shift+K", contexts: ["terminal"], editable: true, handler: unavailable("Limpiar terminal") },
        { id: "terminal.reconnect", title: "Reconectar sesión", description: "Reconectar la terminal", category: "Terminal", defaultShortcut: "Ctrl+Shift+Backspace", contexts: ["terminal"], editable: true, handler: unavailable("Reconectar sesión") },
    ];
    for (let i = 1; i <= 9; i++) {
        commands.push({ id: `workspace.focusModule${i}`, title: `Enfocar módulo ${i}`, description: `Enfocar la pestaña ${i}`, category: "General", defaultShortcut: `Ctrl+${i}`, contexts: ["global"], editable: true, handler: () => switchTabAbs(i) });
    }
    commands.forEach(register);
}
