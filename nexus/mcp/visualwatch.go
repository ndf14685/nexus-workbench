// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// Change detection: la parte barata del pipeline de observación. Antes de
// molestar a un modelo de visión (caro, lento, y con implicancias de privacidad
// si la imagen sale del host) se compara el frame con el anterior usando un
// hash perceptual de 64 bits. Sólo un cambio significativo justifica un evento.
//
//	frame N, frame N+1 -> aHash -> distancia de Hamming -> significativo?
//	   no  -> se descarta, el frame muere acá
//	   si  -> evento al cerebro (metadata, NUNCA el frame)
//
// El algoritmo es el mismo aHash que usa el Observer Fabric del cerebro
// (app/intelligence/observer/fabric/change.py) para que ambos lados hablen del
// mismo número cuando comparan.
package main

import (
	"bytes"
	"fmt"

	"image/jpeg"
	"math/bits"
	"time"
)

// phashSize: 8x8 = 64 bits. Suficiente para "cambió la pantalla" y lo bastante
// grosero para no disparar con el cursor parpadeando.
const phashSize = 8

// PerceptualHash calcula el aHash del frame. Devuelve "" si el frame no se
// puede decodificar: un hash inventado sería peor que no tener hash.
func PerceptualHash(data []byte) string {
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return ""
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w == 0 || h == 0 {
		return ""
	}
	// Muestreo por vecino más cercano: no hace falta un resize de calidad para
	// un hash de 64 bits, y evita traer una dependencia de imagen.
	var gray [phashSize * phashSize]uint32
	var sum uint32
	for y := 0; y < phashSize; y++ {
		for x := 0; x < phashSize; x++ {
			sx := bounds.Min.X + x*w/phashSize
			sy := bounds.Min.Y + y*h/phashSize
			r, g, b, _ := img.At(sx, sy).RGBA()
			// luma BT.601 sobre los 8 bits altos
			v := (299*(r>>8) + 587*(g>>8) + 114*(b>>8)) / 1000
			gray[y*phashSize+x] = v
			sum += v
		}
	}
	avg := sum / uint32(len(gray))
	var hash uint64
	for _, v := range gray {
		hash <<= 1
		if v >= avg {
			hash |= 1
		}
	}
	return fmt.Sprintf("%016x", hash)
}

// HammingFraction devuelve la fracción de bits distintos (0 = idénticos,
// 1 = opuestos). Hashes vacíos o de distinto largo cuentan como "todo distinto":
// no se puede afirmar que no cambió lo que no se pudo medir.
func HammingFraction(a, b string) float64 {
	if a == "" || b == "" || len(a) != len(b) {
		return 1.0
	}
	var x, y uint64
	if _, err := fmt.Sscanf(a, "%016x", &x); err != nil {
		return 1.0
	}
	if _, err := fmt.Sscanf(b, "%016x", &y); err != nil {
		return 1.0
	}
	return float64(bits.OnesCount64(x^y)) / float64(len(a)*4)
}

// Motivos de decisión, para que el evento explique por qué existe (o por qué no).
const (
	ChangeForced      = "forced"
	ChangeDetected    = "changed"
	ChangeNone        = "no_significant_change"
	ChangeDuplicate   = "duplicate"
	ChangeCooldown    = "cooldown"
	ChangeUndecodable = "undecodable"
	ChangeFirstFrame  = "first_frame"
)

// ChangeDecision es el veredicto sobre un frame.
type ChangeDecision struct {
	Analyze  bool    `json:"analyze"`
	Reason   string  `json:"reason"`
	PHash    string  `json:"phash,omitempty"`
	Distance float64 `json:"distance"`
}

// DefaultChangeThreshold: 12% de los bits. Empírico y compartido con el Observer
// Fabric del cerebro; por debajo de eso son cambios de ruido/compresión.
const DefaultChangeThreshold = 0.12

// ChangeDetector es secuencial por diseño: un watch, un detector. No es
// thread-safe a propósito — quien lo comparta entre goroutines lo protege.
type ChangeDetector struct {
	Threshold float64
	Cooldown  time.Duration
	Now       func() time.Time

	lastHash       string
	lastAnalyzedAt time.Time
	seen           map[string]bool
	seenOrder      []string
	Analyzed       int
	Skipped        int
}

// dedupWindow: cuántos hashes de contenido recordar para no re-analizar una
// pantalla que va y vuelve (alt-tab entre dos ventanas).
const dedupWindow = 16

func NewChangeDetector(threshold float64, cooldown time.Duration) *ChangeDetector {
	if threshold <= 0 {
		threshold = DefaultChangeThreshold
	}
	return &ChangeDetector{
		Threshold: threshold,
		Cooldown:  cooldown,
		Now:       time.Now,
		seen:      map[string]bool{},
	}
}

// Evaluate decide si el frame merece un evento. `force` es el camino explícito
// (alguien pidió mirar ahora) y saltea todos los filtros menos el decodificado.
func (d *ChangeDetector) Evaluate(data []byte, contentHash string, force bool) ChangeDecision {
	hash := PerceptualHash(data)
	if hash == "" {
		d.Skipped++
		return ChangeDecision{Analyze: false, Reason: ChangeUndecodable}
	}
	if force {
		return d.accept(hash, contentHash, ChangeForced, 0)
	}
	if d.lastHash == "" {
		// El primero fija la línea de base pero NO cuenta como observación: si
		// arrancara el cooldown, el primer cambio real quedaría suprimido justo
		// cuando el watch recién empieza a mirar, que es cuando más importa.
		return d.baseline(hash, contentHash)
	}
	if contentHash != "" && d.seen[contentHash] {
		return d.reject(ChangeDuplicate, hash, 0)
	}
	dist := HammingFraction(d.lastHash, hash)
	if dist < d.Threshold {
		return d.reject(ChangeNone, hash, dist)
	}
	if d.Cooldown > 0 && !d.lastAnalyzedAt.IsZero() &&
		d.Now().Sub(d.lastAnalyzedAt) < d.Cooldown {
		// Cambió, pero hace muy poco que avisamos: no se inunda al cerebro.
		return d.reject(ChangeCooldown, hash, dist)
	}
	return d.accept(hash, contentHash, ChangeDetected, dist)
}

// baseline fija el hash de referencia sin marcar una observación: no hubo
// evento, así que tampoco hay nada de lo que enfriarse.
func (d *ChangeDetector) baseline(hash, contentHash string) ChangeDecision {
	d.lastHash = hash
	d.remember(contentHash)
	return ChangeDecision{Analyze: true, Reason: ChangeFirstFrame, PHash: hash}
}

func (d *ChangeDetector) remember(contentHash string) {
	if contentHash == "" {
		return
	}
	if !d.seen[contentHash] {
		d.seenOrder = append(d.seenOrder, contentHash)
		d.seen[contentHash] = true
	}
	for len(d.seenOrder) > dedupWindow {
		delete(d.seen, d.seenOrder[0])
		d.seenOrder = d.seenOrder[1:]
	}
}

func (d *ChangeDetector) accept(hash, contentHash, reason string, dist float64) ChangeDecision {
	d.lastHash = hash
	d.lastAnalyzedAt = d.Now()
	d.remember(contentHash)
	d.Analyzed++
	return ChangeDecision{Analyze: true, Reason: reason, PHash: hash, Distance: dist}
}

func (d *ChangeDetector) reject(reason, hash string, dist float64) ChangeDecision {
	d.Skipped++
	return ChangeDecision{Analyze: false, Reason: reason, PHash: hash, Distance: dist}
}

// ReductionRatio: qué proporción de frames NO llegó a producir un evento. Es la
// métrica que justifica todo este archivo.
func (d *ChangeDetector) ReductionRatio() float64 {
	total := d.Analyzed + d.Skipped
	if total == 0 {
		return 0
	}
	return float64(d.Skipped) / float64(total)
}
