package build

import (
	"path/filepath"
	"testing"
)

func TestLocalDestinationPath(t *testing.T) {
	base := t.TempDir()

	dest, err := localDestinationPath(base, filepath.Join("static", "index.html"))
	if err != nil {
		t.Fatalf("local destination path: %v", err)
	}
	want := filepath.Join(base, "static", "index.html")
	if dest != want {
		t.Fatalf("destination = %q, want %q", dest, want)
	}

	for _, relPath := range []string{"../outside", "/tmp/outside"} {
		if _, err := localDestinationPath(base, relPath); err == nil {
			t.Errorf("expected %q to be rejected", relPath)
		}
	}
}
