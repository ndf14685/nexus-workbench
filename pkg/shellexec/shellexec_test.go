// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package shellexec

import "testing"

func TestBuildRemoteCdCommand(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"bare tilde", "~", `cd "$HOME"`},
		{"tilde path", "~/workspace", `cd "$HOME"/workspace`},
		{"tilde path with spaces", "~/dir con espacios", `cd "$HOME"/'dir con espacios'`},
		{"absolute path", "/home/ndf/x", "cd /home/ndf/x"},
		{"absolute path with spaces", "/home/ndf/con espacio", "cd '/home/ndf/con espacio'"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := BuildRemoteCdCommand(c.in)
			if got != c.want {
				t.Fatalf("BuildRemoteCdCommand(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}
