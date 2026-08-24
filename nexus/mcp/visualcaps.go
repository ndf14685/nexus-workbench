// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Capabilities visual.* del client_type workbench. Son la única puerta al
// dispositivo: el cerebro nunca abre la capturadora, la pide.
//
//	visual.sources.list  metadata de las fuentes (nunca frames)
//	visual.snapshot      un frame, explícito, efímero
//	visual.observe       un frame para analizar, con intención declarada
//	visual.watch         vigilar cambios; emite eventos, no frames
//
// Ver el bloque y dejar que la IA mire son permisos distintos: estas
// capabilities miran `ai_vision` de la fuente, que NO se activa porque el
// usuario haya abierto el bloque.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Límites del watch. Existen para que "avisame cuando cambie" no se convierta en
// un proceso eterno que nadie recuerda haber arrancado.
const (
	watchMinInterval     = 1 * time.Second
	watchDefaultInterval = 5 * time.Second
	watchDefaultTTL      = 30 * time.Minute
	watchMaxTTL          = 4 * time.Hour
	watchDefaultMaxEvent = 20
	watchDefaultCooldown = 10 * time.Second
)

// VisualEventSink entrega eventos al cerebro. Se inyecta para poder testear el
// watch sin red.
type VisualEventSink func(kind string, payload map[string]any) error

type watchHandle struct {
	SourceId  string    `json:"source_id"`
	Task      string    `json:"task,omitempty"`
	StartedAt time.Time `json:"started_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Interval  float64   `json:"interval_s"`
	Threshold float64   `json:"threshold"`
	MaxEvents int       `json:"max_events"`
	Events    int       `json:"events"`
	Frames    int       `json:"frames"`
	Skipped   int       `json:"skipped"`
	cancel    context.CancelFunc
}

// VisualCapabilities agrupa el provider, los watches vivos y el canal de
// eventos. Es lo que el JarvisAgent consulta al recibir una capability visual.*.
type VisualCapabilities struct {
	registry *VisualSourceRegistry
	sink     VisualEventSink
	audit    func(tool, env, detail, decision string)

	mu      sync.Mutex
	watches map[string]*watchHandle
}

func NewVisualCapabilities(reg *VisualSourceRegistry, sink VisualEventSink,
	audit func(tool, env, detail, decision string)) *VisualCapabilities {
	if audit == nil {
		audit = func(string, string, string, string) {}
	}
	return &VisualCapabilities{registry: reg, sink: sink, audit: audit,
		watches: map[string]*watchHandle{}}
}

// visualCapabilityDefs se registran ante el cerebro junto con las de terminal.
// El cerebro las proyecta a su registry de gobernanza como
// client.workbench.<name> con esta clase de riesgo, así que la clase es una
// decisión de seguridad, no una etiqueta.
var visualCapabilityDefs = []map[string]any{
	{"name": "visual.sources.list",
		"description": "fuentes visuales configuradas y su estado (metadata, sin imagen)",
		"risk_class":  "read"},
	{"name": "visual.snapshot",
		"description": "un frame de una fuente visual explícita",
		"risk_class":  "read"},
	{"name": "visual.observe",
		"description": "un frame de una fuente explícita para análisis visual, con intención declarada",
		"risk_class":  "read"},
	{"name": "visual.watch",
		"description": "vigilar cambios significativos de una fuente; emite eventos, no frames",
		"risk_class":  "reversible-write"},
}

// aiVisionAllows: la puerta que separa al viewer humano del observador IA. `off`
// significa off aunque el bloque esté abierto en pantalla.
func aiVisionAllows(mode string) error {
	if mode == AIVisionOff {
		return fmt.Errorf("ai_vision=off para esta fuente: el usuario no autorizó observación por IA")
	}
	return nil
}

// Execute atiende una capability visual.*. Devuelve (nil, nil) si no le
// corresponde, para que el dispatcher siga buscando.
func (vc *VisualCapabilities) Execute(ctx context.Context, capability string,
	args map[string]any) (map[string]any, bool, error) {
	str := func(key string) string {
		v, _ := args[key].(string)
		return strings.TrimSpace(v)
	}
	switch capability {
	case "visual.sources.list":
		list, err := vc.registry.List(ctx)
		if err != nil {
			return nil, true, err
		}
		return map[string]any{"sources": visualSourcesPayload(list)}, true, nil

	case "visual.snapshot":
		out, err := vc.capture(ctx, str("source_id"), "", "visual.snapshot")
		return out, true, err

	case "visual.observe":
		task := str("task")
		if task == "" {
			task = str("question")
		}
		out, err := vc.capture(ctx, str("source_id"), task, "visual.observe")
		return out, true, err

	case "visual.watch":
		out, err := vc.watch(ctx, args)
		return out, true, err
	}
	return nil, false, nil
}

// visualSourcesPayload es lo que ve el cerebro: identidad, estado y modo de
// observación. Nunca bytes de imagen (§7).
func visualSourcesPayload(list []ResolvedSource) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, s := range list {
		entry := map[string]any{
			"id": s.Id, "label": s.Label, "type": s.Type,
			"status": s.Status, "available": s.Available,
			"ai_vision": s.AIVision, "audio_available": s.AudioFound,
		}
		if s.Error != "" {
			entry["error"] = s.Error
		}
		if s.Device != nil {
			// El nombre del dispositivo ayuda al diagnóstico; la ruta PnP no
			// aporta nada al cerebro y es ruido identificatorio.
			entry["device"] = s.Device.Name
		}
		if s.MatchedBy != "" {
			entry["matched_by"] = s.MatchedBy
		}
		out = append(out, entry)
	}
	return out
}

// capture es el camino común de snapshot y observe: resolver, autorizar,
// capturar, auditar. El frame va en base64 porque es la única forma de cruzar el
// protocolo, y es de un solo frame: no hay stream por acá.
func (vc *VisualCapabilities) capture(ctx context.Context, sourceId, task, tool string) (map[string]any, error) {
	if sourceId == "" {
		return nil, fmt.Errorf("source_id requerido (ver visual.sources.list)")
	}
	res, err := vc.registry.Get(ctx, sourceId)
	if err != nil {
		vc.audit(tool, "", "source="+sourceId, "error_unknown_source")
		return nil, err
	}
	if err := aiVisionAllows(res.AIVision); err != nil {
		vc.audit(tool, "", "source="+sourceId, "denied_ai_vision_off")
		return nil, err
	}
	data, res, err := vc.registry.Snapshot(ctx, sourceId)
	if err != nil {
		code := ErrStreamFailed
		var ve *VisualError
		if AsVisualError(err, &ve) {
			code = ve.Code
		}
		vc.audit(tool, "", "source="+sourceId+" code="+code, "failed")
		return nil, err
	}
	meta := DescribeFrame(data)
	vc.audit(tool, "", fmt.Sprintf("source=%s %dx%d hash=%s task=%s",
		sourceId, meta.Width, meta.Height, meta.ContentHash, task), "allowed")
	out := map[string]any{
		"source_id": res.Id, "label": res.Label, "ai_vision": res.AIVision,
		"frame":        meta,
		"image_base64": base64.StdEncoding.EncodeToString(data),
		"image_format": "jpeg",
	}
	if task != "" {
		out["task"] = task
	}
	return out, nil
}

// --- watch ---

func (vc *VisualCapabilities) watch(ctx context.Context, args map[string]any) (map[string]any, error) {
	sourceId, _ := args["source_id"].(string)
	sourceId = strings.TrimSpace(sourceId)
	action, _ := args["action"].(string)
	action = strings.TrimSpace(strings.ToLower(action))
	if action == "" {
		action = "start"
	}

	switch action {
	case "status":
		return map[string]any{"watches": vc.watchStatus()}, nil
	case "stop":
		if sourceId == "" {
			return nil, fmt.Errorf("source_id requerido para stop")
		}
		stopped := vc.stopWatch(sourceId)
		vc.audit("visual.watch", "", "source="+sourceId+" action=stop", "allowed")
		return map[string]any{"stopped": stopped, "source_id": sourceId}, nil
	case "start":
	default:
		return nil, fmt.Errorf("action inválida %q (start|stop|status)", action)
	}

	if sourceId == "" {
		return nil, fmt.Errorf("source_id requerido (ver visual.sources.list)")
	}
	res, err := vc.registry.Get(ctx, sourceId)
	if err != nil {
		return nil, err
	}
	// Vigilar es observar: si la IA no puede mirar esta fuente, no hay watch.
	if err := aiVisionAllows(res.AIVision); err != nil {
		vc.audit("visual.watch", "", "source="+sourceId, "denied_ai_vision_off")
		return nil, err
	}
	if vc.sink == nil {
		return nil, fmt.Errorf("no hay canal de eventos hacia el cerebro configurado")
	}

	interval := durationArg(args, "interval_s", watchDefaultInterval)
	if interval < watchMinInterval {
		interval = watchMinInterval
	}
	ttl := durationArg(args, "ttl_s", watchDefaultTTL)
	if ttl > watchMaxTTL {
		ttl = watchMaxTTL
	}
	threshold := floatArg(args, "threshold", DefaultChangeThreshold)
	maxEvents := intArg(args, "max_events", watchDefaultMaxEvent)
	task, _ := args["task"].(string)

	vc.stopWatch(sourceId) // reiniciar en vez de acumular watches duplicados

	// El watch NO cuelga del contexto de la invocación: la llamada del cerebro
	// termina en milisegundos y la vigilancia sigue. Sí muere por TTL, por stop
	// explícito, o si la fuente desaparece.
	watchCtx, cancel := context.WithCancel(context.Background())
	now := time.Now()
	h := &watchHandle{
		SourceId: sourceId, Task: strings.TrimSpace(task),
		StartedAt: now, ExpiresAt: now.Add(ttl),
		Interval: interval.Seconds(), Threshold: threshold,
		MaxEvents: maxEvents, cancel: cancel,
	}
	vc.mu.Lock()
	vc.watches[sourceId] = h
	vc.mu.Unlock()

	vc.audit("visual.watch", "", fmt.Sprintf("source=%s interval=%s ttl=%s task=%s",
		sourceId, interval, ttl, h.Task), "allowed")
	go vc.runWatch(watchCtx, h, interval, ttl)

	return map[string]any{
		"watching": true, "source_id": sourceId, "label": res.Label,
		"interval_s": interval.Seconds(), "threshold": threshold,
		"max_events": maxEvents, "expires_at": h.ExpiresAt.UnixMilli(),
	}, nil
}

func (vc *VisualCapabilities) runWatch(ctx context.Context, h *watchHandle,
	interval, ttl time.Duration) {
	detector := NewChangeDetector(h.Threshold, watchDefaultCooldown)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	deadline := time.After(ttl)

	defer func() {
		vc.mu.Lock()
		if cur := vc.watches[h.SourceId]; cur == h {
			delete(vc.watches, h.SourceId)
		}
		vc.mu.Unlock()
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline:
			vc.emit("visual.watch.ended", map[string]any{
				"source_id": h.SourceId, "reason": "ttl", "events": h.Events,
				"frames": h.Frames, "skipped": h.Skipped, "task": h.Task})
			return
		case <-ticker.C:
		}

		capCtx, cancel := context.WithTimeout(ctx, SnapshotMaxWait)
		data, res, err := vc.registry.Snapshot(capCtx, h.SourceId)
		cancel()
		if err != nil {
			var ve *VisualError
			code := ErrStreamFailed
			if AsVisualError(err, &ve) {
				code = ve.Code
			}
			if code == ErrDeviceBusy {
				// El viewer humano tomó el dispositivo. No es un fallo del watch:
				// se saltea este tick sin ruido.
				h.Skipped++
				continue
			}
			// La fuente se cayó: se avisa una vez y se termina. Reintentar en
			// loop contra un device ausente es quemar CPU.
			vc.emit("visual.watch.ended", map[string]any{
				"source_id": h.SourceId, "reason": "source_lost", "error_code": code,
				"error": err.Error(), "events": h.Events, "task": h.Task})
			return
		}
		h.Frames++
		meta := DescribeFrame(data)
		decision := detector.Evaluate(data, meta.ContentHash, false)
		// El frame muere acá salvo que haya cambio: nunca se guarda ni se manda.
		if !decision.Analyze {
			h.Skipped++
			continue
		}
		if decision.Reason == ChangeFirstFrame {
			// La línea de base no es una novedad para nadie.
			continue
		}
		h.Events++
		vc.emit("visual.change", map[string]any{
			"source_id": h.SourceId, "label": res.Label, "task": h.Task,
			"reason": decision.Reason, "distance": round3(decision.Distance),
			"phash": decision.PHash, "frame": meta,
			"observed_frames": h.Frames, "skipped_frames": h.Skipped,
			"reduction_ratio": round3(detector.ReductionRatio()),
			// El cerebro decide si vale una mirada cara: si la quiere, pide
			// visual.observe. Acá no viaja la imagen.
			"needs_observation": true,
		})
		if h.MaxEvents > 0 && h.Events >= h.MaxEvents {
			vc.emit("visual.watch.ended", map[string]any{
				"source_id": h.SourceId, "reason": "max_events",
				"events": h.Events, "frames": h.Frames, "task": h.Task})
			return
		}
	}
}

func (vc *VisualCapabilities) emit(kind string, payload map[string]any) {
	if vc.sink == nil {
		return
	}
	if err := vc.sink(kind, payload); err != nil {
		log.Printf("visual: no se pudo emitir %s: %v", kind, err)
	}
}

func (vc *VisualCapabilities) stopWatch(sourceId string) bool {
	vc.mu.Lock()
	h, ok := vc.watches[sourceId]
	if ok {
		delete(vc.watches, sourceId)
	}
	vc.mu.Unlock()
	if ok && h.cancel != nil {
		h.cancel()
	}
	return ok
}

// StopAll corta toda vigilancia. Lo llama el apagado del agente: no se deja una
// goroutine mirando una capturadora después de que el proceso se fue.
func (vc *VisualCapabilities) StopAll() {
	vc.mu.Lock()
	handles := make([]*watchHandle, 0, len(vc.watches))
	for _, h := range vc.watches {
		handles = append(handles, h)
	}
	vc.watches = map[string]*watchHandle{}
	vc.mu.Unlock()
	for _, h := range handles {
		if h.cancel != nil {
			h.cancel()
		}
	}
}

func (vc *VisualCapabilities) watchStatus() []map[string]any {
	vc.mu.Lock()
	defer vc.mu.Unlock()
	out := make([]map[string]any, 0, len(vc.watches))
	for _, h := range vc.watches {
		out = append(out, map[string]any{
			"source_id": h.SourceId, "task": h.Task,
			"started_at": h.StartedAt.UnixMilli(), "expires_at": h.ExpiresAt.UnixMilli(),
			"interval_s": h.Interval, "threshold": h.Threshold,
			"events": h.Events, "frames": h.Frames, "skipped": h.Skipped,
		})
	}
	return out
}

// --- helpers de argumentos ---

func floatArg(args map[string]any, key string, def float64) float64 {
	switch v := args[key].(type) {
	case float64:
		if v > 0 {
			return v
		}
	case int:
		if v > 0 {
			return float64(v)
		}
	}
	return def
}

func intArg(args map[string]any, key string, def int) int {
	if v := floatArg(args, key, float64(def)); v > 0 {
		return int(v)
	}
	return def
}

func durationArg(args map[string]any, key string, def time.Duration) time.Duration {
	if v := floatArg(args, key, 0); v > 0 {
		return time.Duration(v * float64(time.Second))
	}
	return def
}

func round3(v float64) float64 {
	return float64(int(v*1000+0.5)) / 1000
}

// --- canal de eventos hacia el cerebro ---

// brainEventSink publica en POST /events del cerebro, que es el ingest que ya
// existe para eventos de clientes. No se inventa un transporte nuevo.
func brainEventSink(brainURL, token, clientID string, httpc *http.Client) VisualEventSink {
	return func(kind string, payload map[string]any) error {
		body, err := json.Marshal(map[string]any{
			"kind": kind, "source": clientID, "payload": payload,
		})
		if err != nil {
			return err
		}
		req, err := http.NewRequest(http.MethodPost, strings.TrimRight(brainURL, "/")+"/events",
			bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := httpc.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			return fmt.Errorf("POST /events -> %d", resp.StatusCode)
		}
		return nil
	}
}
