// Copyright 2026, Nexus Workbench (fork extension)
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	maxKubeOutputBytes = 4 << 20
	maxKubeLogLines    = 2000
	maxKubeLogBytes    = 1 << 20
)

var kubeIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,252}$`)
var kubeContextPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@:/-]{0,252}$`)

type cappedKubeBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (writer *cappedKubeBuffer) Write(data []byte) (int, error) {
	remaining := writer.limit - writer.buffer.Len()
	if remaining <= 0 {
		return 0, fmt.Errorf("kubectl response exceeded %d bytes", writer.limit)
	}
	if len(data) > remaining {
		_, _ = writer.buffer.Write(data[:remaining])
		return remaining, fmt.Errorf("kubectl response exceeded %d bytes", writer.limit)
	}
	return writer.buffer.Write(data)
}

func validateKubeIdentifier(field, value string, allowEmpty bool) error {
	if value == "" && allowEmpty {
		return nil
	}
	pattern := kubeIdentifierPattern
	if field == "context" {
		pattern = kubeContextPattern
	}
	if !pattern.MatchString(value) || strings.HasPrefix(value, "-") || strings.Contains(value, "..") {
		return fmt.Errorf("invalid Kubernetes %s", field)
	}
	return nil
}

func kubectlArgs(contextName string, args ...string) []string {
	result := make([]string, 0, len(args)+2)
	if contextName != "" {
		result = append(result, "--context", contextName)
	}
	return append(result, args...)
}

func runKubectl(ctx context.Context, kubectlPath string, maxBytes int, args ...string) ([]byte, error) {
	commandCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, kubectlPath, args...)
	stdout := cappedKubeBuffer{limit: maxBytes}
	stderr := cappedKubeBuffer{limit: 64 << 10}
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("kubectl timed out")
		}
		message := strings.TrimSpace(stderr.buffer.String())
		if len(message) > 512 {
			message = message[:512]
		}
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("kubectl failed: %s", message)
	}
	return stdout.buffer.Bytes(), nil
}

type kubeObjectList struct {
	Items []struct {
		Kind     string `json:"kind"`
		Metadata struct {
			Name              string    `json:"name"`
			Namespace         string    `json:"namespace"`
			CreationTimestamp time.Time `json:"creationTimestamp"`
		} `json:"metadata"`
		Spec struct {
			Replicas int `json:"replicas"`
		} `json:"spec"`
		Status struct {
			Phase             string `json:"phase"`
			ReadyReplicas     int    `json:"readyReplicas"`
			AvailableReplicas int    `json:"availableReplicas"`
			Succeeded         int    `json:"succeeded"`
			Failed            int    `json:"failed"`
			ContainerStatuses []struct {
				Ready        bool `json:"ready"`
				RestartCount int  `json:"restartCount"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

func formatKubeAge(created time.Time) string {
	if created.IsZero() {
		return ""
	}
	age := time.Since(created)
	if age < time.Hour {
		return fmt.Sprintf("%dm", int(age.Minutes()))
	}
	if age < 48*time.Hour {
		return fmt.Sprintf("%dh", int(age.Hours()))
	}
	return fmt.Sprintf("%dd", int(age.Hours()/24))
}

func parseKubeResources(payload []byte) ([]wshrpc.KubeResource, error) {
	var list kubeObjectList
	if err := json.Unmarshal(payload, &list); err != nil {
		return nil, fmt.Errorf("invalid kubectl resource response: %w", err)
	}
	resources := make([]wshrpc.KubeResource, 0, len(list.Items))
	for _, item := range list.Items {
		resource := wshrpc.KubeResource{
			Kind: item.Kind, Namespace: item.Metadata.Namespace, Name: item.Metadata.Name,
			Age: formatKubeAge(item.Metadata.CreationTimestamp),
		}
		switch item.Kind {
		case "Pod":
			ready := 0
			for _, container := range item.Status.ContainerStatuses {
				if container.Ready {
					ready++
				}
				resource.Restarts += container.RestartCount
			}
			resource.Ready = fmt.Sprintf("%d/%d", ready, len(item.Status.ContainerStatuses))
			resource.Status = item.Status.Phase
		default:
			resource.Ready = fmt.Sprintf("%d/%d", item.Status.ReadyReplicas, item.Spec.Replicas)
			if item.Status.Failed > 0 || item.Status.ReadyReplicas < item.Spec.Replicas {
				resource.Status = "Degraded"
			} else {
				resource.Status = "Ready"
			}
		}
		resources = append(resources, resource)
	}
	return resources, nil
}

type kubeNamespaceList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
	} `json:"items"`
}

type kubeEventList struct {
	Items []struct {
		Type     string `json:"type"`
		Message  string `json:"message"`
		Reason   string `json:"reason"`
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Regarding struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		} `json:"regarding"`
	} `json:"items"`
}

func (impl *ServerImpl) RemoteKubeOverviewCommand(ctx context.Context, request wshrpc.KubeOverviewRequest) (*wshrpc.KubeOverview, error) {
	if err := validateKubeIdentifier("context", request.Context, true); err != nil {
		return nil, err
	}
	if err := validateKubeIdentifier("namespace", request.Namespace, true); err != nil {
		return nil, err
	}
	kubectlPath, err := exec.LookPath("kubectl")
	if err != nil {
		return &wshrpc.KubeOverview{Available: false}, nil
	}
	overview := &wshrpc.KubeOverview{Available: true, KubectlPath: kubectlPath}
	if output, runErr := runKubectl(ctx, kubectlPath, 64<<10, "config", "current-context"); runErr == nil {
		overview.CurrentContext = strings.TrimSpace(string(output))
	}
	if output, runErr := runKubectl(ctx, kubectlPath, 256<<10, "config", "get-contexts", "-o", "name"); runErr == nil {
		for _, name := range strings.Split(strings.TrimSpace(string(output)), "\n") {
			if name != "" {
				overview.Contexts = append(overview.Contexts, name)
			}
		}
	}
	selectedContext := request.Context
	if selectedContext == "" {
		selectedContext = overview.CurrentContext
	}
	namespacePayload, err := runKubectl(ctx, kubectlPath, maxKubeOutputBytes, kubectlArgs(selectedContext, "get", "namespaces", "-o", "json")...)
	if err != nil {
		return nil, err
	}
	var namespaces kubeNamespaceList
	if err := json.Unmarshal(namespacePayload, &namespaces); err != nil {
		return nil, fmt.Errorf("invalid namespace response: %w", err)
	}
	for _, namespace := range namespaces.Items {
		overview.Namespaces = append(overview.Namespaces, namespace.Metadata.Name)
	}
	sort.Strings(overview.Namespaces)
	resourceArgs := []string{"get", "pods,deployments,statefulsets,daemonsets,jobs"}
	if request.Namespace != "" {
		resourceArgs = append(resourceArgs, "-n", request.Namespace)
	} else {
		resourceArgs = append(resourceArgs, "-A")
	}
	resourceArgs = append(resourceArgs, "-o", "json")
	resourcePayload, err := runKubectl(ctx, kubectlPath, maxKubeOutputBytes, kubectlArgs(selectedContext, resourceArgs...)...)
	if err != nil {
		return nil, err
	}
	overview.Resources, err = parseKubeResources(resourcePayload)
	if err != nil {
		return nil, err
	}
	eventArgs := []string{"get", "events"}
	if request.Namespace != "" {
		eventArgs = append(eventArgs, "-n", request.Namespace)
	} else {
		eventArgs = append(eventArgs, "-A")
	}
	eventArgs = append(eventArgs, "-o", "json")
	if eventPayload, eventErr := runKubectl(ctx, kubectlPath, maxKubeOutputBytes, kubectlArgs(selectedContext, eventArgs...)...); eventErr == nil {
		var events kubeEventList
		if json.Unmarshal(eventPayload, &events) == nil {
			start := 0
			if len(events.Items) > 50 {
				start = len(events.Items) - 50
			}
			for _, event := range events.Items[start:] {
				overview.Events = append(overview.Events, wshrpc.KubeResource{
					Kind: event.Regarding.Kind, Namespace: event.Metadata.Namespace, Name: event.Regarding.Name,
					Status: event.Type, Message: event.Reason + ": " + event.Message,
				})
			}
		}
	}
	return overview, nil
}

func sanitizeKubeLogRequest(request wshrpc.KubeLogsRequest) (wshrpc.KubeLogsRequest, error) {
	for field, value := range map[string]string{
		"context": request.Context, "namespace": request.Namespace, "pod": request.Pod, "container": request.Container,
	} {
		allowEmpty := field == "context" || field == "container"
		if err := validateKubeIdentifier(field, value, allowEmpty); err != nil {
			return request, err
		}
	}
	if request.TailLines <= 0 {
		request.TailLines = 200
	}
	if request.TailLines > maxKubeLogLines {
		request.TailLines = maxKubeLogLines
	}
	return request, nil
}

func (impl *ServerImpl) RemoteKubeLogsCommand(ctx context.Context, request wshrpc.KubeLogsRequest) (string, error) {
	clean, err := sanitizeKubeLogRequest(request)
	if err != nil {
		return "", err
	}
	kubectlPath, err := exec.LookPath("kubectl")
	if err != nil {
		return "", fmt.Errorf("kubectl is not installed or not in PATH")
	}
	args := []string{"logs", clean.Pod, "-n", clean.Namespace, "--tail", strconv.Itoa(clean.TailLines), "--timestamps"}
	if clean.Container != "" {
		args = append(args, "-c", clean.Container)
	}
	output, err := runKubectl(ctx, kubectlPath, maxKubeLogBytes, kubectlArgs(clean.Context, args...)...)
	return string(output), err
}
