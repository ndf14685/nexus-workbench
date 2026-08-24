// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func leafOrder(entries ...waveobj.LeafOrderEntry) *[]waveobj.LeafOrderEntry {
	out := append([]waveobj.LeafOrderEntry(nil), entries...)
	return &out
}

func TestFocusedBlockInLayout(t *testing.T) {
	cases := []struct {
		name   string
		layout *waveobj.LayoutState
		want   string
	}{
		{name: "nil layout", layout: nil, want: ""},
		{
			name:   "sin foco",
			layout: &waveobj.LayoutState{LeafOrder: leafOrder(waveobj.LeafOrderEntry{NodeId: "n1", BlockId: "b1"})},
			want:   "",
		},
		{
			name:   "sin leaf order",
			layout: &waveobj.LayoutState{FocusedNodeId: "n1"},
			want:   "",
		},
		{
			name: "foco resuelve al bloque correcto",
			layout: &waveobj.LayoutState{
				FocusedNodeId: "n3",
				LeafOrder: leafOrder(
					waveobj.LeafOrderEntry{NodeId: "n1", BlockId: "bA"},
					waveobj.LeafOrderEntry{NodeId: "n2", BlockId: "bB"},
					waveobj.LeafOrderEntry{NodeId: "n3", BlockId: "bC"},
					waveobj.LeafOrderEntry{NodeId: "n4", BlockId: "bD"},
				),
			},
			want: "bC",
		},
		{
			// El caso que importa para el resolver: 4 terminales y el foco en la
			// tercera. Si esto devolviera la primera, "segui con esto" ejecutaria
			// sobre el repo equivocado.
			name: "cuatro bloques, foco en el tercero",
			layout: &waveobj.LayoutState{
				FocusedNodeId: "nC",
				LeafOrder: leafOrder(
					waveobj.LeafOrderEntry{NodeId: "nA", BlockId: "term-A"},
					waveobj.LeafOrderEntry{NodeId: "nB", BlockId: "term-B"},
					waveobj.LeafOrderEntry{NodeId: "nC", BlockId: "term-C"},
					waveobj.LeafOrderEntry{NodeId: "nD", BlockId: "term-D"},
				),
			},
			want: "term-C",
		},
		{
			name: "foco a un nodo que ya no es hoja",
			layout: &waveobj.LayoutState{
				FocusedNodeId: "fantasma",
				LeafOrder:     leafOrder(waveobj.LeafOrderEntry{NodeId: "n1", BlockId: "b1"}),
			},
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := focusedBlockInLayout(tc.layout); got != tc.want {
				t.Fatalf("focusedBlockInLayout = %q, quiero %q", got, tc.want)
			}
		})
	}
}
