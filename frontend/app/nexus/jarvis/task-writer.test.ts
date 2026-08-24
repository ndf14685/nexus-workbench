// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { agentForCommand, instructionFromCommand } from "./task-writer";

describe("agentForCommand", () => {
    it("reconoce sesiones de agente", () => {
        expect(agentForCommand("claude")).toBe("claude-code");
        expect(agentForCommand("claude --resume")).toBe("claude-code");
        expect(agentForCommand("/usr/local/bin/claude")).toBe("claude-code");
        expect(agentForCommand("codex exec")).toBe("codex");
        expect(agentForCommand("aider --model x")).toBe("aider");
    });

    it("un comando cualquiera NO es una tarea", () => {
        // Si `ls` contara como tarea, "los tres puntos" podria resolver contra
        // un `ls` y Jarvis contestaria cualquier cosa con total confianza.
        expect(agentForCommand("ls -la")).toBe("");
        expect(agentForCommand("git status")).toBe("");
        expect(agentForCommand("npm run build")).toBe("");
        expect(agentForCommand("")).toBe("");
        expect(agentForCommand("   ")).toBe("");
    });

    it("no confunde subcadenas", () => {
        expect(agentForCommand("echo claudette")).toBe("");
        expect(agentForCommand("cat codexample.txt")).toBe("");
    });
});

describe("instructionFromCommand", () => {
    it("extrae el prompt cuando viaja en la linea de comando", () => {
        expect(instructionFromCommand('claude -p "resolver tres cosas"')).toBe("resolver tres cosas");
        expect(instructionFromCommand("claude --prompt 'arreglar el login'")).toBe("arreglar el login");
        expect(instructionFromCommand('codex --print "hacer X"')).toBe("hacer X");
    });

    it("un unico argumento entrecomillado tambien es prompt", () => {
        expect(instructionFromCommand('claude "corregir el bug"')).toBe("corregir el bug");
    });

    it("devuelve vacio cuando el prompt se tipea dentro de la TUI", () => {
        // Este es el caso real: el dueno abre `claude` y escribe los tres
        // puntos adentro. La instruccion NO esta en la linea de comando, y
        // preferimos vacio antes que inventar.
        expect(instructionFromCommand("claude")).toBe("");
        expect(instructionFromCommand("claude --resume")).toBe("");
    });

    it("no explota con basura", () => {
        expect(instructionFromCommand("")).toBe("");
        expect(instructionFromCommand("   ")).toBe("");
    });
});
