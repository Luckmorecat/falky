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
	HealthOK HealthStatus = "ok"
	// HealthDegraded is an optional component that cannot be used, or a
	// server that is ready while one is.
	HealthDegraded HealthStatus = "degraded"
	// HealthUnavailable is a required component that cannot be used, or a
	// server that is not ready because one is.
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
	// failed is the component's status while probe returns an error.
	failed HealthStatus
	logs   *FailureLog
}

// HealthReport is the result of checking every component.
type HealthReport struct {
	// Status is HealthUnavailable when a required component is unavailable,
	// otherwise HealthDegraded when an optional one is, otherwise HealthOK.
	Status HealthStatus
	// Components holds each component's status by name.
	Components map[string]HealthStatus
}

// Ready reports whether the server can serve requests.
func (r HealthReport) Ready() bool {
	return r.Status != HealthUnavailable
}

// NewHealth returns a Health with no components; failed probes are logged to
// logger.
func NewHealth(logger *slog.Logger) *Health {
	return &Health{logger: logger}
}

// Require adds a component the server cannot serve without: while probe
// returns an error, the component is unavailable and the server is not ready.
func (h *Health) Require(name string, probe func(context.Context) error) {
	h.checks = append(h.checks, healthCheck{name: name, probe: probe, failed: HealthUnavailable, logs: &FailureLog{}})
}

// Optional adds a component the server keeps serving without, with less
// working: while probe returns an error, the component is degraded and the
// server stays ready.
func (h *Health) Optional(name string, probe func(context.Context) error) {
	h.checks = append(h.checks, healthCheck{name: name, probe: probe, failed: HealthDegraded, logs: &FailureLog{}})
}

// Check probes every component.
func (h *Health) Check(ctx context.Context) HealthReport {
	report := HealthReport{Status: HealthOK, Components: make(map[string]HealthStatus, len(h.checks))}
	for _, c := range h.checks {
		pctx, cancel := context.WithTimeout(ctx, probeTimeout)
		err := c.probe(pctx)
		cancel()
		c.logs.Report(ctx, h.logger, "health probe", err, "component", c.name)
		if err != nil {
			report.Components[c.name] = c.failed
			if report.Status != HealthUnavailable {
				report.Status = c.failed
			}
			continue
		}
		report.Components[c.name] = HealthOK
	}
	return report
}
