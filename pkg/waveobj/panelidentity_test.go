// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import (
	"testing"
)

// These tests cover the data-layer guarantees for the per-panel identity layer (custom title + note).
// The frontend writes frame:title / frame:note via SetMetaCommand, which merges through MergeMeta with
// mergeSpecial=false. A nil value deletes a key (used for "reset custom title").

func mergeBlock(base MetaMapType, update MetaMapType) MetaMapType {
	return MergeMeta(base, update, false)
}

func TestPanelCustomTitleSetAndUpdate(t *testing.T) {
	meta := MetaMapType{"view": "term", "connection": "ndf@192.168.50.105:22222"}

	meta = mergeBlock(meta, MetaMapType{MetaKey_FrameTitle: "CyberLab · OSINT"})
	if meta[MetaKey_FrameTitle] != "CyberLab · OSINT" {
		t.Fatalf("expected custom title to be set, got %v", meta[MetaKey_FrameTitle])
	}

	meta = mergeBlock(meta, MetaMapType{MetaKey_FrameTitle: "CyberLab · Report"})
	if meta[MetaKey_FrameTitle] != "CyberLab · Report" {
		t.Fatalf("expected custom title to be updated, got %v", meta[MetaKey_FrameTitle])
	}
	if meta["connection"] != "ndf@192.168.50.105:22222" {
		t.Fatalf("connection should be untouched, got %v", meta["connection"])
	}
}

func TestPanelNoteCrud(t *testing.T) {
	meta := MetaMapType{MetaKey_FrameTitle: "NexusOS · CV ATS"}

	meta = mergeBlock(meta, MetaMapType{MetaKey_FrameNote: "Building the ATS CV generator"})
	if meta[MetaKey_FrameNote] != "Building the ATS CV generator" {
		t.Fatalf("expected note to be set, got %v", meta[MetaKey_FrameNote])
	}

	meta = mergeBlock(meta, MetaMapType{MetaKey_FrameNote: "Building the ATS CV generator (v2)"})
	if meta[MetaKey_FrameNote] != "Building the ATS CV generator (v2)" {
		t.Fatalf("expected note to be updated, got %v", meta[MetaKey_FrameNote])
	}

	// delete note (blank -> nil), custom title must remain
	meta = mergeBlock(meta, MetaMapType{MetaKey_FrameNote: nil})
	if _, ok := meta[MetaKey_FrameNote]; ok {
		t.Fatalf("expected note to be deleted, still present: %v", meta[MetaKey_FrameNote])
	}
	if meta[MetaKey_FrameTitle] != "NexusOS · CV ATS" {
		t.Fatalf("custom title should survive note deletion, got %v", meta[MetaKey_FrameTitle])
	}
}

func TestPanelResetCustomTitleFallsBack(t *testing.T) {
	meta := MetaMapType{
		"view":            "web",
		MetaKey_FrameTitle: "ChatGPT · Agentes",
		MetaKey_FrameNote:  "Multi-agent coordination",
	}

	// reset: nil deletes the key so the header falls back to the auto title
	meta = mergeBlock(meta, MetaMapType{MetaKey_FrameTitle: nil})
	if _, ok := meta[MetaKey_FrameTitle]; ok {
		t.Fatalf("expected custom title to be removed on reset, got %v", meta[MetaKey_FrameTitle])
	}
	if meta[MetaKey_FrameNote] != "Multi-agent coordination" {
		t.Fatalf("note should survive title reset, got %v", meta[MetaKey_FrameNote])
	}
}

func TestPanelCustomTitleSurvivesWebNavigation(t *testing.T) {
	meta := MetaMapType{
		"view":            "web",
		"url":             "https://chatgpt.com/",
		MetaKey_FrameTitle: "ChatGPT · Agentes",
		MetaKey_FrameNote:  "Analyzing multi-agent coordination",
	}

	// a navigation only writes the url meta key (see webview handleNavigate); title/note must not change
	meta = mergeBlock(meta, MetaMapType{"url": "https://chatgpt.com/c/some-other-thread"})

	if meta[MetaKey_FrameTitle] != "ChatGPT · Agentes" {
		t.Fatalf("custom title must survive web navigation, got %v", meta[MetaKey_FrameTitle])
	}
	if meta[MetaKey_FrameNote] != "Analyzing multi-agent coordination" {
		t.Fatalf("note must survive web navigation, got %v", meta[MetaKey_FrameNote])
	}
	if meta["url"] != "https://chatgpt.com/c/some-other-thread" {
		t.Fatalf("url should be updated, got %v", meta["url"])
	}
}

func TestPanelCustomTitleSurvivesCwdUpdate(t *testing.T) {
	meta := MetaMapType{
		"view":            "term",
		MetaKey_FrameTitle: "Trading · Canary",
	}

	// a terminal cwd change (OSC 7) only writes cmd:cwd; the custom title must be untouched
	meta = mergeBlock(meta, MetaMapType{"cmd:cwd": "/workspace/trading"})

	if meta[MetaKey_FrameTitle] != "Trading · Canary" {
		t.Fatalf("custom title must survive cwd update, got %v", meta[MetaKey_FrameTitle])
	}
	if meta["cmd:cwd"] != "/workspace/trading" {
		t.Fatalf("cwd should be set, got %v", meta["cmd:cwd"])
	}
}

func TestPanelBlockWithoutIdentityMetaUnchanged(t *testing.T) {
	meta := MetaMapType{"view": "term", "controller": "shell"}

	// a plain block that never gets identity meta should merge normally and gain no identity keys
	merged := mergeBlock(meta, MetaMapType{"cmd:cwd": "/home/ndf"})
	if _, ok := merged[MetaKey_FrameTitle]; ok {
		t.Fatalf("no custom title expected on a plain block")
	}
	if _, ok := merged[MetaKey_FrameNote]; ok {
		t.Fatalf("no note expected on a plain block")
	}
	if merged["view"] != "term" {
		t.Fatalf("view should be preserved, got %v", merged["view"])
	}
}
