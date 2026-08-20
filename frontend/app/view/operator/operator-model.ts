// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// Modelo puro del cockpit de atención. Sin React, sin fetch: solo las
// decisiones de presentación, para poder testearlas.
//
// Regla UX de esta vista: DISMINUIR estímulos. No es un cockpit de Boeing.
// El detalle existe, pero hay que abrirlo a propósito.

import type { NeedsYouEntry, TodayView } from "@/app/nexus/jarvis/brain-client";

export type OperatorState = "NORMAL" | "FOCUS" | "RECOVERY";

export const OperatorStates: OperatorState[] = ["NORMAL", "FOCUS", "RECOVERY"];

export const StateLabels: Record<string, string> = {
    NORMAL: "Normal",
    FOCUS: "Focus",
    RECOVERY: "Recuperación",
};

export const StateHints: Record<string, string> = {
    NORMAL: "Hasta 5 interrupciones no críticas por día.",
    FOCUS: "Hasta 2. Solo lo importante llega.",
    RECOVERY: "Cero interrupciones no críticas. Solo seguridad y deadlines reales.",
};

/** Clases del chip activo por estado (Tailwind v4, tokens del tema). */
export const StateChipClasses: Record<string, string> = {
    NORMAL: "bg-accent/80 text-primary hover:bg-accent",
    FOCUS: "bg-accent/80 text-primary hover:bg-accent",
    RECOVERY: "bg-warning/80 text-background hover:bg-warning",
};

export const EmptyToday: TodayView = {
    operator_state: "NORMAL",
    needs_you: [],
    needs_you_total: 0,
    running: 0,
    running_items: [],
    done_for_you: 0,
    done_for_you_items: [],
    watching: 0,
    watching_items: [],
    quiet: true,
    message: "",
    budget_remaining: 0,
};

/**
 * En RECOVERY con nada urgente, el cockpit colapsa a una sola tarjeta: no hay
 * contadores, no hay backlog, no hay "cosas que podríamos construir".
 */
export function isCalmMode(view: TodayView): boolean {
    return view.operator_state === "RECOVERY" && view.quiet;
}

/**
 * Las líneas de la tarjeta mínima. Solo se dice lo que pasó, nunca lo que
 * falta: mostrar trabajo sacado, no trabajo creado.
 */
export function calmLines(view: TodayView): string[] {
    const lines = [view.message || "No hay nada urgente."];
    if (view.done_for_you > 0) {
        lines.push(
            view.done_for_you === 1
                ? "1 tarea resuelta automáticamente."
                : `${view.done_for_you} tareas resueltas automáticamente.`
        );
    }
    if (view.running > 0) {
        lines.push(
            view.running === 1 ? "1 proceso sigue en ejecución." : `${view.running} procesos siguen en ejecución.`
        );
    }
    return lines;
}

export interface Counter {
    key: string;
    label: string;
    value: number;
    tone: "attention" | "neutral" | "good";
}

/**
 * Los cuatro contadores de TODAY. WATCHING desaparece en RECOVERY: son
 * condiciones que el sistema vigila y que todavía no requieren nada.
 */
export function counters(view: TodayView): Counter[] {
    const out: Counter[] = [
        { key: "needs", label: "NEEDS YOU", value: view.needs_you_total, tone: view.needs_you_total > 0 ? "attention" : "neutral" },
        { key: "running", label: "RUNNING", value: view.running, tone: "neutral" },
        { key: "done", label: "DONE FOR YOU", value: view.done_for_you, tone: "good" },
    ];
    if (view.operator_state !== "RECOVERY") {
        out.push({ key: "watching", label: "WATCHING", value: view.watching, tone: "neutral" });
    }
    return out;
}

/**
 * El cerebro ya recorta NEEDS YOU según el estado de carga. La vista respeta
 * ese corte y NO trae más: si hay 12 pendientes y la política dice 1, se
 * muestra 1. Nunca se reordena acá — la prioridad tiene un solo dueño.
 */
export function visibleNeedsYou(view: TodayView): NeedsYouEntry[] {
    return view.needs_you ?? [];
}

/** Cuántos pendientes quedaron fuera de la vista deliberadamente. */
export function hiddenNeedsYouCount(view: TodayView): number {
    return Math.max(0, (view.needs_you_total ?? 0) - visibleNeedsYou(view).length);
}

export function dueLabel(dueAt: number | null, now: number): string {
    if (dueAt == null) {
        return "";
    }
    const seconds = dueAt - now / 1000;
    if (seconds <= 0) {
        return "vencido";
    }
    const hours = seconds / 3600;
    if (hours < 1) {
        return `vence en ${Math.max(1, Math.round(seconds / 60))} min`;
    }
    if (hours < 48) {
        return `vence en ${Math.round(hours)} h`;
    }
    return `vence en ${Math.round(hours / 24)} d`;
}

/** Texto de una entrada: la acción concreta, no el título decorativo. */
export function actionText(entry: NeedsYouEntry): string {
    return entry.next_action || entry.title;
}
