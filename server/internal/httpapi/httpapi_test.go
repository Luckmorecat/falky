package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/platform"
)

type listeners struct {
	public, internal *httptest.Server
}

func start(t *testing.T, probe func(context.Context) error) listeners {
	t.Helper()
	logger := platform.NewLogger(io.Discard, 0)
	health := platform.NewHealth(logger)
	health.Require("database", probe)
	h := New(Deps{Logger: logger, Health: health, Metrics: platform.NewMetrics().Handler()})
	l := listeners{public: httptest.NewServer(h.Public), internal: httptest.NewServer(h.Internal)}
	t.Cleanup(l.public.Close)
	t.Cleanup(l.internal.Close)
	return l
}

func client(t *testing.T, srv *httptest.Server) *api.ClientWithResponses {
	t.Helper()
	c, err := api.NewClientWithResponses(srv.URL, api.WithHTTPClient(srv.Client()))
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	return c
}

func TestLivenessAnswersOK(t *testing.T) {
	l := start(t, func(context.Context) error { return errors.New("down") })
	res, err := client(t, l.internal).GetLivenessWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetLiveness: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil || res.JSON200.Status != api.HealthStatusOk {
		t.Errorf("GetLiveness = %d %s, want 200 with status ok", res.StatusCode(), res.Body)
	}
}

func TestReadinessNamesEachComponent(t *testing.T) {
	l := start(t, func(context.Context) error { return nil })
	res, err := client(t, l.internal).GetReadinessWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetReadiness: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil {
		t.Fatalf("GetReadiness = %d %s, want 200", res.StatusCode(), res.Body)
	}
	if res.JSON200.Status != api.HealthStatusOk || res.JSON200.Components["database"] != api.HealthStatusOk {
		t.Errorf("body = %s, want status ok and database ok", res.Body)
	}
}

func TestReadinessFailsWhileARequiredComponentIsUnavailable(t *testing.T) {
	l := start(t, func(context.Context) error { return platform.ErrNotMigrated })
	res, err := client(t, l.internal).GetReadinessWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetReadiness: %v", err)
	}
	if res.StatusCode() != http.StatusServiceUnavailable || res.JSON503 == nil {
		t.Fatalf("GetReadiness = %d %s, want 503", res.StatusCode(), res.Body)
	}
	if res.JSON503.Status != api.HealthStatusUnavailable || res.JSON503.Components["database"] != api.HealthStatusUnavailable {
		t.Errorf("body = %s, want status unavailable and database unavailable", res.Body)
	}
}

// get returns the response status, Content-Type and body.
func get(t *testing.T, srv *httptest.Server, path string) (int, string, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	body, err := io.ReadAll(res.Body)
	if err := errors.Join(err, res.Body.Close()); err != nil {
		t.Fatalf("GET %s: read body: %v", path, err)
	}
	return res.StatusCode, res.Header.Get("Content-Type"), body
}

func TestMetricsServePrometheusText(t *testing.T) {
	l := start(t, func(context.Context) error { return nil })
	status, contentType, body := get(t, l.internal, "/metrics")
	if status != http.StatusOK || !strings.HasPrefix(contentType, "text/plain") {
		t.Fatalf("GET /metrics = %d %q, want 200 text/plain", status, contentType)
	}
	for _, metric := range []string{"go_goroutines", "process_cpu_seconds_total"} {
		if !strings.Contains(string(body), "\n"+metric+" ") {
			t.Errorf("/metrics lacks %s", metric)
		}
	}
}

func TestPublicListenerDoesNotServeInternalRoutes(t *testing.T) {
	l := start(t, func(context.Context) error { return nil })
	public := client(t, l.public)

	live, err := public.GetLivenessWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetLiveness: %v", err)
	}
	ready, err := public.GetReadinessWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetReadiness: %v", err)
	}
	for name, res := range map[string]struct {
		status int
		body   *api.Error
	}{
		"/health/live":  {live.StatusCode(), live.JSONDefault},
		"/health/ready": {ready.StatusCode(), ready.JSONDefault},
	} {
		if res.status != http.StatusNotFound || res.body == nil || res.body.Code != "not_found" {
			t.Errorf("public %s = %d %+v, want 404 not_found", name, res.status, res.body)
		}
	}

	// Routes outside the contract.
	for _, path := range []string{"/metrics", "/api/nothing"} {
		status, _, raw := get(t, l.public, path)
		var body api.Error
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("GET %s: decode error body: %v", path, err)
		}
		if status != http.StatusNotFound || body.Code != "not_found" {
			t.Errorf("public GET %s = %d %+v, want 404 not_found", path, status, body)
		}
	}
}
