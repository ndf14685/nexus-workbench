package wshremote

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestValidateKubeIdentifier(t *testing.T) {
	for _, value := range []string{"dev", "kind-local", "team.alpha", "user@example", "arn:aws:eks:region:account:cluster/dev"} {
		if err := validateKubeIdentifier("context", value, true); err != nil {
			t.Fatalf("expected %q to be valid: %v", value, err)
		}
	}
	for _, value := range []string{"--token=x", "dev; rm -rf /", "../config", strings.Repeat("a", 254)} {
		if err := validateKubeIdentifier("context", value, false); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}

func TestParseKubeResources(t *testing.T) {
	payload := []byte(`{"items":[
		{"kind":"Pod","metadata":{"name":"api-1","namespace":"apps","creationTimestamp":"2026-01-01T00:00:00Z"},"status":{"phase":"Running","containerStatuses":[{"ready":true,"restartCount":2}]}},
		{"kind":"Deployment","metadata":{"name":"api","namespace":"apps"},"spec":{"replicas":3},"status":{"readyReplicas":2,"availableReplicas":2}}
	]}`)
	resources, err := parseKubeResources(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(resources) != 2 || resources[0].Status != "Running" || resources[0].Restarts != 2 {
		t.Fatalf("unexpected pod: %#v", resources)
	}
	if resources[1].Ready != "2/3" || resources[1].Status != "Degraded" {
		t.Fatalf("unexpected deployment: %#v", resources[1])
	}
}

func TestSanitizeKubeLogRequest(t *testing.T) {
	req := wshrpc.KubeLogsRequest{Context: "dev", Namespace: "apps", Pod: "api-1", Container: "api", TailLines: 5000}
	clean, err := sanitizeKubeLogRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if clean.TailLines != maxKubeLogLines {
		t.Fatalf("expected tail clamp to %d, got %d", maxKubeLogLines, clean.TailLines)
	}
	if _, err := sanitizeKubeLogRequest(wshrpc.KubeLogsRequest{Namespace: "apps", Pod: "--all"}); err == nil {
		t.Fatal("expected option-like pod to be rejected")
	}
}
