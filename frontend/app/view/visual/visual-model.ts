// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

// VisualSourceViewModel: el consumidor humano de una fuente visual. Abre el
// stream, lo muestra y lo suelta. No decide nada sobre observación por IA: eso
// vive en la configuración de la fuente y lo aplica el provider del host.
//
// Ciclo de vida: el stream pertenece a ESTE modelo, no al layout ni al store
// global. Un MediaStream en un atom global sería un track que nadie cierra.

import { getSettingsKeyAtom, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { BlockNodeModel } from "@/app/block/blocktypes";
import * as jotai from "jotai";
import { VisualSourceView } from "./visual";
import {
    buildConstraints,
    classifyMediaError,
    labelsAreHidden,
    resolveDevice,
    type DeviceMatchKind,
    type EnumeratedDevice,
} from "@/app/nexus/visual/device-resolver";
import {
    describeVisualError,
    findSource,
    normalizeAIVision,
    sourceLabel,
    VisualSourcesSettingsKey,
    type AIVisionMode,
    type VisualErrorCode,
    type VisualSourceConfig,
} from "@/app/nexus/visual/visual-types";

export type VisualStatus = "idle" | "connecting" | "live" | "offline" | "error";

export interface VisualState {
    status: VisualStatus;
    code?: VisualErrorCode;
    detail?: string;
    matchedBy?: DeviceMatchKind;
    width?: number;
    height?: number;
    fps?: number;
}

// Meta del bloque: qué fuente muestra. Vive en el bloque (no en un atom global)
// para que el layout la persista y la restaure como cualquier otra propiedad.
export const MetaSourceKey = "visual:source";
// Marca que este bloque tiene el dispositivo tomado. El provider del host la lee
// para no pelearle la capturadora a un viewer humano (el device UVC es
// exclusivo: verificado con dos consumidores simultáneos).
export const MetaViewerKey = "visual:viewer";

// Reconexión: backoff acotado. Una capturadora desenchufada no justifica
// reintentar para siempre a toda velocidad.
const ReconnectDelaysMs = [1000, 2000, 5000, 10000];

export class VisualSourceViewModel implements ViewModel {
    viewType = "visual";

    // getter y no propiedad: difiere la evaluacion del import circular
    // modelo <-> componente, que es el patron que ya usan las otras vistas.
    get viewComponent(): ViewComponent {
        return VisualSourceView;
    }

    blockId: string;
    nodeModel: BlockNodeModel;

    viewIcon = jotai.atom<string>("display");
    // derivado: el header muestra la etiqueta de la fuente configurada
    viewName: jotai.Atom<string>;
    noPadding = jotai.atom<boolean>(true);

    blockAtom: jotai.Atom<Block>;
    stateAtom: jotai.PrimitiveAtom<VisualState>;
    // Dispositivos vistos por el renderer; alimenta el selector de fuente.
    devicesAtom: jotai.PrimitiveAtom<EnumeratedDevice[]>;
    sourcesAtom: jotai.Atom<VisualSourceConfig[]>;
    sourceIdAtom: jotai.Atom<string>;
    sourceAtom: jotai.Atom<VisualSourceConfig | null>;
    aiVisionAtom: jotai.Atom<AIVisionMode>;
    viewText: jotai.Atom<HeaderElem[]>;

    videoRef: React.RefObject<HTMLVideoElement> = { current: null };

    private stream: MediaStream | null = null;
    private disposed = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempt = 0;
    private deviceChangeHandler: (() => void) | null = null;
    // generación: invalida los arranques en vuelo. Sin esto, un stream que
    // resuelve tarde se adjunta a un bloque que ya se cerró y queda un track
    // abierto contra la capturadora.
    private generation = 0;

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId));
        this.stateAtom = jotai.atom<VisualState>({ status: "idle" }) as jotai.PrimitiveAtom<VisualState>;
        this.devicesAtom = jotai.atom<EnumeratedDevice[]>([]) as jotai.PrimitiveAtom<EnumeratedDevice[]>;

        this.sourcesAtom = jotai.atom((get) => {
            const raw = get(getSettingsKeyAtom(VisualSourcesSettingsKey)) as VisualSourceConfig[] | undefined;
            if (!Array.isArray(raw)) {
                return [] as VisualSourceConfig[];
            }
            return raw.filter((src) => typeof src?.id === "string" && src.id.trim() !== "");
        });

        // La fuente del bloque: la de su meta, o la primera configurada. Con la
        // meta vacía el bloque sigue siendo válido: muestra "sin fuente".
        this.sourceIdAtom = jotai.atom((get) => {
            const meta = get(this.blockAtom)?.meta ?? {};
            const fromMeta = meta[MetaSourceKey] as string;
            if (fromMeta) {
                return fromMeta;
            }
            const sources = get(this.sourcesAtom);
            return sources.length > 0 ? sources[0].id : "";
        });

        this.sourceAtom = jotai.atom((get) => findSource(get(this.sourcesAtom), get(this.sourceIdAtom)));

        this.aiVisionAtom = jotai.atom((get) => normalizeAIVision(get(this.sourceAtom)?.aivision));

        this.viewName = jotai.atom((get) => {
            const src = get(this.sourceAtom);
            return src ? sourceLabel(src) : "HMI";
        });

        // El header dice el estado real: LIVE, OFFLINE o el código del error.
        this.viewText = jotai.atom((get) => {
            const state = get(this.stateAtom);
            const parts: HeaderElem[] = [];
            if (state.status === "live") {
                parts.push({ elemtype: "text", text: "● LIVE", className: "text-success" });
                if (state.width && state.height) {
                    const fps = state.fps ? ` ${Math.round(state.fps)}fps` : "";
                    parts.push({ elemtype: "text", text: `${state.width}x${state.height}${fps}` });
                }
            } else if (state.status === "connecting") {
                parts.push({ elemtype: "text", text: "conectando…", className: "text-secondary" });
            } else if (state.status !== "idle") {
                parts.push({ elemtype: "text", text: state.code ?? "OFFLINE", className: "text-error" });
            }
            return parts;
        });
    }

    // --- ciclo de vida del stream ---

    async start(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const gen = ++this.generation;
        this.clearReconnect();
        this.stopStream();

        const source = globalStore.get(this.sourceAtom);
        if (source == null) {
            this.setState({
                status: "offline",
                code: "NO_DEVICE",
                detail: "No hay ninguna fuente visual configurada.",
            });
            return;
        }
        this.setState({ status: "connecting" });

        let devices: EnumeratedDevice[] = [];
        try {
            devices = (await navigator.mediaDevices.enumerateDevices()) as unknown as EnumeratedDevice[];
        } catch (e) {
            this.fail(gen, classifyMediaError(e));
            return;
        }
        if (gen !== this.generation || this.disposed) {
            return;
        }
        globalStore.set(this.devicesAtom, devices);

        // Sin permiso, Chromium oculta los labels y no se puede identificar el
        // dispositivo. Se pide el permiso una vez (el prompt del Workbench lo
        // persiste por origen) y se reintenta la enumeración.
        if (labelsAreHidden(devices)) {
            try {
                const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                probe.getTracks().forEach((t) => t.stop());
                devices = (await navigator.mediaDevices.enumerateDevices()) as unknown as EnumeratedDevice[];
                if (gen !== this.generation || this.disposed) {
                    return;
                }
                globalStore.set(this.devicesAtom, devices);
            } catch (e) {
                this.fail(gen, classifyMediaError(e));
                return;
            }
        }

        const match = resolveDevice(source.device, devices);
        if (match.device == null) {
            // Acá NO se cae en otra cámara: la fuente queda offline y el bloque
            // ofrece reconectar o elegir otra fuente.
            this.fail(gen, {
                code: match.matchedBy === "ambiguous_name" ? "NO_DEVICE" : "NO_DEVICE",
                detail:
                    match.matchedBy === "ambiguous_name"
                        ? "Hay más de un dispositivo con ese nombre: configurá vid/pid."
                        : "",
            });
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia(
                buildConstraints(match.device.deviceId, source.width, source.height)
            );
            if (gen !== this.generation || this.disposed) {
                // El bloque se cerró mientras el device se abría: se suelta ya.
                stream.getTracks().forEach((t) => t.stop());
                return;
            }
            this.stream = stream;
            this.attachStream();
            const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
            this.setState({
                status: "live",
                matchedBy: match.matchedBy,
                width: settings.width,
                height: settings.height,
                fps: settings.frameRate,
            });
            this.reconnectAttempt = 0;
            this.markViewerAttached(true);
            // El propio track avisa cuando el dispositivo desaparece.
            stream.getVideoTracks().forEach((track) => {
                track.onended = () => this.handleTrackEnded();
            });
        } catch (e) {
            this.fail(gen, classifyMediaError(e));
        }
    }

    attachStream() {
        if (this.videoRef.current && this.stream) {
            this.videoRef.current.srcObject = this.stream;
        }
    }

    private handleTrackEnded() {
        if (this.disposed) {
            return;
        }
        this.stopStream();
        this.setState({ status: "offline", code: "DEVICE_REMOVED" });
        this.scheduleReconnect();
    }

    private fail(gen: number, err: { code: string; detail: string }) {
        if (gen !== this.generation || this.disposed) {
            return;
        }
        const code = err.code as VisualErrorCode;
        this.setState({
            status: code === "PERMISSION_DENIED" ? "error" : "offline",
            code,
            detail: err.detail,
        });
        this.markViewerAttached(false);
        // Un permiso denegado no se arregla reintentando: sólo el usuario puede.
        if (code !== "PERMISSION_DENIED") {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (this.disposed || this.reconnectTimer != null) {
            return;
        }
        const delay = ReconnectDelaysMs[Math.min(this.reconnectAttempt, ReconnectDelaysMs.length - 1)];
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.disposed) {
                void this.start();
            }
        }, delay);
    }

    private clearReconnect() {
        if (this.reconnectTimer != null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    // Reconexión manual: reinicia el backoff porque la pidió una persona.
    reconnect() {
        this.reconnectAttempt = 0;
        void this.start();
    }

    stopStream() {
        if (this.stream) {
            // Cada track se cierra explícitamente: sin esto la capturadora queda
            // tomada y el LED del dispositivo sigue encendido.
            this.stream.getTracks().forEach((track) => {
                track.onended = null;
                track.stop();
            });
            this.stream = null;
        }
        if (this.videoRef.current) {
            this.videoRef.current.srcObject = null;
        }
        this.markViewerAttached(false);
    }

    // --- selección de fuente ---

    async selectSource(sourceId: string): Promise<void> {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { [MetaSourceKey]: sourceId },
        });
        this.reconnect();
    }

    // markViewerAttached publica en la meta del bloque que el device está
    // tomado. El provider del host lo lee antes de capturar: es el árbitro entre
    // el viewer humano y el observador IA.
    private markViewerAttached(attached: boolean) {
        const sourceId = globalStore.get(this.sourceIdAtom);
        if (!sourceId) {
            return;
        }
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", this.blockId),
            meta: { [MetaViewerKey]: attached ? true : null },
        }).catch(() => {
            // Que falle el aviso no puede tumbar el viewer: el peor caso es que
            // un snapshot devuelva DEVICE_BUSY, que ya es un estado contemplado.
        });
    }

    // --- observación por IA ---

    // El modo de la fuente es configuración, no estado del bloque: cambiarlo
    // acá lo cambia para todos los consumidores, que es la semántica correcta
    // (es un permiso sobre la fuente, no sobre esta ventana).
    async setAIVision(mode: AIVisionMode): Promise<void> {
        const sources = globalStore.get(this.sourcesAtom);
        const sourceId = globalStore.get(this.sourceIdAtom);
        const next = sources.map((src) => (src.id === sourceId ? { ...src, aivision: mode } : src));
        await RpcApi.SetConfigCommand(TabRpcClient, { [VisualSourcesSettingsKey]: next });
    }

    // --- integración con el resto del bloque ---

    setState(state: VisualState) {
        globalStore.set(this.stateAtom, state);
    }

    statusMessage(state: VisualState): string {
        return describeVisualError((state.code ?? "STREAM_FAILED") as VisualErrorCode, state.detail);
    }

    // El navegador avisa cuando se enchufa o desenchufa un dispositivo: es la
    // señal barata para reconectar sin poll.
    installDeviceWatcher() {
        if (this.deviceChangeHandler != null || navigator.mediaDevices?.addEventListener == null) {
            return;
        }
        this.deviceChangeHandler = () => {
            const state = globalStore.get(this.stateAtom);
            if (state.status !== "live") {
                this.reconnect();
            }
        };
        navigator.mediaDevices.addEventListener("devicechange", this.deviceChangeHandler);
    }

    removeDeviceWatcher() {
        if (this.deviceChangeHandler != null) {
            navigator.mediaDevices.removeEventListener?.("devicechange", this.deviceChangeHandler);
            this.deviceChangeHandler = null;
        }
    }

    giveFocus(): boolean {
        return false;
    }

    // dispose lo llama el Workbench al cerrar el bloque. Todo lo que este modelo
    // abrió se cierra acá: tracks, timers y listeners. Cero excepciones.
    dispose() {
        this.disposed = true;
        this.generation++;
        this.clearReconnect();
        this.removeDeviceWatcher();
        this.stopStream();
    }
}
