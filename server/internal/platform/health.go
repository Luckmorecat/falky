package platform

import (
	"context"
	"log/slog"
	"time"
)

// HealthStatus is the state of one component, or of the server as a whole.
type HealthStatus string

// Health statuses.
const (
	HealthOK          HealthStatus = "ok"
	HealthUnavailable HealthStatus = "unavailable"
)

// probeTimeout bounds each component probe.
const probeTimeout = 2 * time.Second

// Health checks the components the server depends on.
type Health struct {
	logger *slog.Logger
	checks []healthCheck
}

type healthCheck struct {
	name  string
	probe func(context.Context) error
}

// HealthReport is the result of checking every component.
type HealthReport struct {
	// Status is HealthOK when every component is, HealthUnavailable otherwise.
	Status HealthStatus
	// Components holds each component's status by name.
	Components map[string]HealthStatus
}

// Ready reports whether the server can serve requests.
func (r HealthReport) Ready() bool {
	return r.Status == HealthOK
}

// NewHealth returns a Health with no components; failed probes are logged to
// logger.
func NewHealth(logger *slog.Logger) *Health {
	return &Health{logger: logger}
}

// Require adds a component the server cannot serve without: while probe
// returns an error, the component is unavailable and the server is not ready.
func (h *Health) Require(name string, probe func(context.Context) error) {
	h.checks = append(h.checks, healthCheck{name: name, probe: probe})
}

// Check probes every component.
func (h *Health) Check(ctx context.Context) HealthReport {
	report := HealthReport{Status: HealthOK, Components: make(map[string]HealthStatus, len(h.checks))}
	for _, c := range h.checks {
		pctx, cancel := context.WithTimeout(ctx, probeTimeout)
		err := c.probe(pctx)
		cancel()
		if err != nil {
			h.logger.WarnContext(ctx, "health probe failed", "component", c.name, "error", err)
			report.Components[c.name] = HealthUnavailable
			report.Status = HealthUnavailable
			continue
		}
		report.Components[c.name] = HealthOK
	}
	return report
}
