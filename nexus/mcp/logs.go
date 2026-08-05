// Copyright 2026, Nexus Workbench
// SPDX-License-Identifier: Apache-2.0

// showLogs del contrato del Bridge. Seguir un pod, una unit de systemd y las
// alertas del SIEM son el mismo gesto con tres comandos distintos que hay que
// recordar; acá se declaran una vez y se abren como bloques en el mismo layout.
package main

import (
	"fmt"
	"strconv"
	"strings"
)

type LogSource struct {
	Kind      string // kubernetes | systemd | journal | docker | file | wazuh
	Target    string // pod/deployment, unit, contenedor, ruta
	Namespace string // sólo kubernetes
	Container string // sólo kubernetes
	Lines     int
	Follow    bool
	Grep      string
}

// Un target o un namespace se interpolan en un comando de shell y pueden venir
// de un agente: mismo criterio que los parámetros de runbook.
func validateLogField(name string, value string) error {
	if value == "" {
		return nil
	}
	if unsafeParamPattern.MatchString(value) {
		return fmt.Errorf("el valor de %q contiene metacaracteres de shell", name)
	}
	return nil
}

func (s LogSource) validate() error {
	if strings.TrimSpace(s.Target) == "" && s.Kind != "wazuh" {
		return fmt.Errorf("falta el target del log (%s)", s.Kind)
	}
	for name, value := range map[string]string{"target": s.Target, "namespace": s.Namespace, "container": s.Container, "grep": s.Grep} {
		if err := validateLogField(name, value); err != nil {
			return err
		}
	}
	if s.Lines < 0 || s.Lines > 100000 {
		return fmt.Errorf("lines fuera de rango")
	}
	return nil
}

// BuildLogCommand arma el comando de seguimiento. Es de sólo lectura por
// construcción: ninguna de las variantes muta estado.
func BuildLogCommand(s LogSource) (string, error) {
	if err := s.validate(); err != nil {
		return "", err
	}
	lines := s.Lines
	if lines == 0 {
		lines = 200
	}
	n := strconv.Itoa(lines)
	follow := ""
	var cmd string
	switch s.Kind {
	case "kubernetes":
		if s.Follow {
			follow = " -f"
		}
		cmd = "kubectl logs" + follow + " --tail " + n
		if s.Namespace != "" {
			cmd += " -n " + s.Namespace
		}
		if s.Container != "" {
			cmd += " -c " + s.Container
		}
		cmd += " " + s.Target
	case "systemd", "journal":
		if s.Follow {
			follow = " -f"
		}
		cmd = "journalctl -u " + s.Target + follow + " -n " + n
	case "docker":
		if s.Follow {
			follow = " -f"
		}
		cmd = "docker logs" + follow + " --tail " + n + " " + s.Target
	case "file":
		flag := "-n"
		if s.Follow {
			flag = "-F -n"
		}
		cmd = "tail " + flag + " " + n + " " + s.Target
	case "wazuh":
		target := s.Target
		if target == "" {
			target = "/var/ossec/logs/alerts/alerts.json"
		}
		if err := validateLogField("target", target); err != nil {
			return "", err
		}
		flag := "-n"
		if s.Follow {
			flag = "-F -n"
		}
		cmd = "tail " + flag + " " + n + " " + target
	default:
		return "", fmt.Errorf("origen de logs desconocido: %q (kubernetes, systemd, journal, docker, file, wazuh)", s.Kind)
	}
	if s.Grep != "" {
		cmd += " | grep --line-buffered -i " + shellQuote(s.Grep)
	}
	return cmd, nil
}

// shellQuote entrecomilla en simples. El valor ya pasó por validateLogField, que
// rechaza la comilla simple junto con el resto de los metacaracteres.
func shellQuote(s string) string {
	return "'" + s + "'"
}
