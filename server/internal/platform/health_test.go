package platform

import (
	"context"
	"errors"
	"io"
	"testing"
)

func TestHealthIsReadyWhenEveryRequiredComponentIs(t *testing.T) {
	h := NewHealth(NewLogger(io.Discard, 0))
	h.Require("database", func(context.Context) error { return nil })
	report := h.Check(t.Context())
	if !report.Ready() || report.Status != HealthOK {
		t.Errorf("report = %+v, want ready and ok", report)
	}
	if report.Components["database"] != HealthOK {
		t.Errorf("database = %q, want ok", report.Components["database"])
	}
}

func TestHealthIsNotReadyWhenARequiredComponentFails(t *testing.T) {
	h := NewHealth(NewLogger(io.Discard, 0))
	h.Require("database", func(context.Context) error { return errors.New("closed") })
	h.Require("other", func(context.Context) error { return nil })
	report := h.Check(t.Context())
	if report.Ready() || report.Status != HealthUnavailable {
		t.Errorf("report = %+v, want not ready and unavailable", report)
	}
	want := map[string]HealthStatus{"database": HealthUnavailable, "other": HealthOK}
	for name, status := range want {
		if report.Components[name] != status {
			t.Errorf("%s = %q, want %q", name, report.Components[name], status)
		}
	}
}

func TestHealthStaysReadyButDegradedWhenAnOptionalComponentFails(t *testing.T) {
	h := NewHealth(NewLogger(io.Discard, 0))
	h.Require("database", func(context.Context) error { return nil })
	h.Optional("livekit", func(context.Context) error { return errors.New("connection refused") })
	report := h.Check(t.Context())
	if !report.Ready() || report.Status != HealthDegraded {
		t.Errorf("report = %+v, want ready and degraded", report)
	}
	want := map[string]HealthStatus{"database": HealthOK, "livekit": HealthDegraded}
	for name, status := range want {
		if report.Components[name] != status {
			t.Errorf("%s = %q, want %q", name, report.Components[name], status)
		}
	}
}

func TestHealthIsUnavailableWhenARequiredAndAnOptionalComponentFail(t *testing.T) {
	h := NewHealth(NewLogger(io.Discard, 0))
	h.Optional("livekit", func(context.Context) error { return errors.New("connection refused") })
	h.Require("database", func(context.Context) error { return errors.New("closed") })
	report := h.Check(t.Context())
	if report.Ready() || report.Status != HealthUnavailable {
		t.Errorf("report = %+v, want not ready and unavailable", report)
	}
}
