// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Registra en la metadata del bloque QUE TAREA recibio esa terminal, para que
// Jarvis pueda resolver "esto" sin que el dueno se lo explique.
//
// ## Por que existe
//
// El snapshot `workbench.context` lee `jarvis:task:*` del bloque. Si nadie lo
// escribe, una terminal abierta a mano nunca tiene tarea y el snapshot llega
// vacio: leer no sirve de nada si del otro lado no hay nada escrito.
//
// ## Que se puede saber y que no
//
// La shell integration (OSC 133 / 16162) da hechos, no interpretaciones:
// cuando arranco un comando, cual, con que agente, cuando termino y con que
// exit code. Eso se escribe tal cual.
//
// Lo que la shell integration NO puede dar es la INSTRUCCION cuando el prompt
// se tipeo dentro de la TUI del agente. `claude` es el comando; los tres puntos
// que el dueno le pidio viven en el scrollback, no en la linea de comando. Por
// eso `instruction` se llena solo cuando viene en los argumentos (`claude -p
// "..."`), y en el resto de los casos queda vacia y se publica
// `raw_output_ref`: Jarvis pide el detalle con `terminal.read` cuando lo
// necesita, en vez de que aca inventemos un resumen que despues se lee como si
// fuera un hecho verificado.
//
// No se persiste stdout: solo la referencia.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

// Bloques con una sesion de agente abierta. Se lleva aca y no leyendo la meta
// porque las claves `jarvis:*` no son parte de MetaType: el writer ya sabe que
// arranco, y preguntarselo al store seria darle la vuelta al dato propio.
const openTasks = new Set<string>();

// Agentes cuya sesion vale como "tarea". Un `ls` no es una tarea, y tratarlo
// como tal envenena la resolucion de deixis: "los tres puntos" no puede
// resolver contra un `ls`.
const AgentPatterns: { re: RegExp; agent: string }[] = [
    { re: /(^|[\\/\s])claude(\.exe)?(\s|$)/i, agent: "claude-code" },
    { re: /(^|[\\/\s])codex(\.exe)?(\s|$)/i, agent: "codex" },
    { re: /(^|[\\/\s])aider(\.exe)?(\s|$)/i, agent: "aider" },
    { re: /(^|[\\/\s])gemini(\.exe)?(\s|$)/i, agent: "gemini-cli" },
];

const MaxInstructionChars = 2000;

export function agentForCommand(command: string): string {
    const text = (command ?? "").trim();
    if (!text) {
        return "";
    }
    for (const entry of AgentPatterns) {
        if (entry.re.test(text)) {
            return entry.agent;
        }
    }
    return "";
}

// instructionFromCommand extrae el prompt SOLO si viaja en la linea de comando.
// Devuelve "" cuando no esta: preferimos vacio a adivinado.
export function instructionFromCommand(command: string): string {
    const text = (command ?? "").trim();
    if (!text) {
        return "";
    }
    // -p/--print/--prompt "<texto>" es la forma no interactiva.
    const flag = text.match(/\s(?:-p|--print|--prompt)\s+("([^"]*)"|'([^']*)'|(\S.*))$/);
    if (flag) {
        const value = flag[2] ?? flag[3] ?? flag[4] ?? "";
        return value.trim().slice(0, MaxInstructionChars);
    }
    // Un unico argumento entrecomillado tambien es un prompt.
    const quoted = text.match(/^\S+\s+("([^"]+)"|'([^']+)')\s*$/);
    if (quoted) {
        return (quoted[2] ?? quoted[3] ?? "").trim().slice(0, MaxInstructionChars);
    }
    return "";
}

async function setTaskMeta(blockId: string, meta: Record<string, unknown>): Promise<void> {
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: `block:${blockId}`, meta }, { timeout: 3000 });
    } catch (e) {
        // Registrar la tarea es un lujo, no un requisito: si falla, la terminal
        // sigue funcionando igual y Jarvis degrada a lo de antes.
        console.warn("[jarvis] no pude registrar la tarea del bloque", e);
    }
}

// recordTaskStart se llama cuando la shell integration avisa que arranco un
// comando. Solo escribe si el comando es una sesion de agente.
export function recordTaskStart(blockId: string, command: string): void {
    const agent = agentForCommand(command);
    if (!agent || !blockId) {
        return;
    }
    const instruction = instructionFromCommand(command);
    openTasks.add(blockId);
    void setTaskMeta(blockId, {
        "jarvis:task:agent": agent,
        "jarvis:task:command": (command ?? "").slice(0, MaxInstructionChars),
        "jarvis:task:instruction": instruction,
        "jarvis:task:status": "running",
        "jarvis:task:started_at": Math.floor(Date.now() / 1000),
        // La salida cruda NO se copia: se referencia. Jarvis pide el detalle
        // con terminal.read si de verdad lo necesita.
        "jarvis:task:raw_output_ref": `block:${blockId}`,
        "jarvis:task:completed_at": null,
        "jarvis:task:result_summary": null,
        "jarvis:result:exit_code": null,
    });
}

// recordTaskFinish se llama cuando la shell integration avisa el exit code.
// No inventa un resumen: dice que termino y con que codigo, que es un hecho.
export function recordTaskFinish(blockId: string, exitCode: number | null): void {
    if (!blockId) {
        return;
    }
    if (!openTasks.delete(blockId)) {
        // Sin tarea abierta no hay nada que cerrar: un `ls` que termina no
        // debe pisar el resultado de la sesion de agente anterior.
        return;
    }
    const ok = exitCode === 0;
    void setTaskMeta(blockId, {
        "jarvis:task:status": exitCode == null ? "stopped" : ok ? "completed" : "failed",
        "jarvis:task:completed_at": Math.floor(Date.now() / 1000),
        "jarvis:result:exit_code": exitCode,
        // Distingue "el agente dijo que termino" de "la postcondicion se
        // verifico". Esto es lo primero; lo segundo lo tiene que comprobar
        // quien lea el resultado.
        "jarvis:task:result_summary": exitCode == null
            ? "la sesion termino sin exit code"
            : ok
              ? "el proceso termino con exit code 0 (no verifica postcondiciones)"
              : `el proceso termino con exit code ${exitCode}`,
    });
}
