// Copyright 2026, Nexus
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package main

// El agente tambien compila y corre sus tests en Linux (CI y worktree del
// server). Ahi no hay escritorio que suene: se declara sin soporte, y el
// cerebro cae al canal visual sabiendo por que.

func chimeSupported() bool { return false }

func playChimeFile(path string) error { return ErrChimeUnsupported }
