// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func TestCommandContextKind(t *testing.T) {
	cases := map[string]string{
		"kubectl get pods":                       "kubernetes",
		"kubectl delete ns staging":              "kubernetes",
		"helm upgrade --install api ./chart":     "kubernetes",
		"/usr/local/bin/kubectl apply -f x.yaml": "kubernetes",
		"sudo kubectl drain node-1":              "kubernetes",
		"KUBECONFIG=/tmp/kc kubectl get ns":      "kubernetes",
		"aws s3 rm s3://bucket --recursive":      "aws",
		"gcloud compute instances delete vm":     "gcloud",
		"terraform apply":                        "terraform",
		"tofu destroy":                           "terraform",
		"ls -la":                                 "",
		"echo kubectl":                           "",
		"git push":                               "",
		"":                                       "",
	}
	for cmd, want := range cases {
		if got := CommandContextKind(cmd); got != want {
			t.Errorf("CommandContextKind(%q) = %q, esperaba %q", cmd, got, want)
		}
	}
}

func TestIsProductionContext(t *testing.T) {
	prod := []string{
		"prod", "production", "prd",
		"arn:aws:eks:us-east-1:1234:cluster/prod-eks",
		"gke_myproject_us-central1_prod-cluster",
		"nexus-prod",
		"prod-k8s",
		"my-company-production",
	}
	for _, name := range prod {
		if !IsProductionContext(name) {
			t.Errorf("%q debería detectarse como producción", name)
		}
	}
	notProd := []string{
		"", "lab", "staging", "dev", "minikube", "docker-desktop",
		"nexus-lab", "gke_myproject_us-central1_staging",
		"reproducible", // "prod" embebido en otra palabra no cuenta
		"producer-queue",
	}
	for _, name := range notProd {
		if IsProductionContext(name) {
			t.Errorf("%q NO debería detectarse como producción", name)
		}
	}
}

func TestParseProbeOutput(t *testing.T) {
	cases := []struct {
		raw  string
		name string
		ok   bool
	}{
		{"prod-eks\n", "prod-eks", true},
		{"\n\nminikube\n", "minikube", true},
		{"WARNING: kubectl version skew\nprod-cluster\n", "prod-cluster", true},
		{"error: no context set\n", "", false},
		{"(unset)\n", "(unset)", true},
		{"<not set>\n", "", false},
		{"bash: gcloud: command not found\n", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		name, ok := ParseProbeOutput(tc.raw)
		if ok != tc.ok || name != tc.name {
			t.Errorf("ParseProbeOutput(%q) = (%q,%v), esperaba (%q,%v)", tc.raw, name, ok, tc.name, tc.ok)
		}
	}
}

func TestContextProbeIsReadOnly(t *testing.T) {
	// el probe corre solo, sin confirmación: no puede ser algo que mute estado
	for _, kind := range []string{"kubernetes", "aws", "gcloud", "terraform"} {
		probe := ContextProbe(kind)
		if probe == "" {
			t.Fatalf("falta probe para %s", kind)
		}
		if IsDestructive(probe) {
			t.Fatalf("el probe de %s se considera destructivo: %s", kind, probe)
		}
	}
	if ContextProbe("nada") != "" {
		t.Fatal("un kind desconocido no debería producir un probe")
	}
}

func TestEffectiveContextLooksProduction(t *testing.T) {
	if (EffectiveContext{Kind: "kubernetes", Name: "prod-eks", Available: true}).LooksProduction() != true {
		t.Fatal("un contexto prod disponible tiene que marcarse")
	}
	// si no pudimos determinarlo no inventamos: la escalada la decide el gate
	if (EffectiveContext{Kind: "kubernetes", Name: "prod-eks", Available: false}).LooksProduction() != false {
		t.Fatal("un contexto no disponible no puede afirmar que es producción")
	}
}
