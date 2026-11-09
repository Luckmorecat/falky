package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/platform"
)

func TestPrivateSignallingListenerPreservesUnchangedExternalEdgeRoute(t *testing.T) {
	var upstreamCalls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			upstreamCalls.Add(1)
		}
		w.WriteHeader(200)
	}))
	t.Cleanup(upstream.Close)
	cfg, err := platform.LoadConfig(env(map[string]string{platform.EnvDBPath: filepath.Join(t.TempDir(), "falky.db"), platform.EnvAdminSocket: filepath.Join(t.TempDir(), "admin.sock"), platform.EnvLiveKitAPIURL: upstream.URL, platform.EnvLiveKitAPIKey: "test", platform.EnvLiveKitAPISecret: "test-secret"}))
	if err != nil {
		t.Fatal(err)
	}
	ls := newListeners(t, cfg.AdminSocket)
	var lc net.ListenConfig
	ls.signalling, err = lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg.SignallingAddr = ls.signalling.Addr().String()
	stop := startServerWith(t, cfg, io.Discard, ls)
	defer stop()
	target, _ := url.Parse("http://" + cfg.SignallingAddr)
	proxy := httputil.NewSingleHostReverseProxy(target)
	// The separately maintained edge sends exactly /rtc and /rtc/* to
	// <project>-voice:7880. DNS resolves that unchanged target to this listener.
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rtc" || strings.HasPrefix(r.URL.Path, "/rtc/") {
			proxy.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(edge.Close)
	fetch := func(target string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		return http.DefaultClient.Do(req)
	}
	for _, path := range []string{"/rtc", "/rtc/validate", "/rtc/v1", "/rtc/v1/validate"} {
		res, err := fetch(edge.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != 403 || res.Header.Get("X-Falky-RTC-Guard") != "1" {
			t.Fatalf("unchanged edge %s = %d, guard %q", path, res.StatusCode, res.Header.Get("X-Falky-RTC-Guard"))
		}
	}
	for _, base := range []string{"http://" + cfg.SignallingAddr, "http://" + ls.public.Addr().String()} {
		for _, path := range []string{"/twirp/livekit.RoomService/ListRooms", "/whip", "/agent", "/debug/pprof", "/metrics", "/health/live", "/livekit/webhook", "/rtc/twirp", "/rtc/../twirp"} {
			res, err := fetch(base + path)
			if err != nil {
				t.Fatal(err)
			}
			_ = res.Body.Close()
			if res.StatusCode != 404 {
				t.Fatalf("management path %s%s = %d", base, path, res.StatusCode)
			}
		}
	}
	res, err := fetch("http://" + cfg.SignallingAddr + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatal("private RTC listener exposed public API")
	}
	if got := upstreamCalls.Load(); got != 0 {
		t.Fatalf("unauthenticated/management requests reached upstream %d times", got)
	}
}

func TestConfiguredSignallingBindFailureFailsStartup(t *testing.T) {
	var lc net.ListenConfig
	occupied, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = occupied.Close() }()
	cfg, err := platform.LoadConfig(env(map[string]string{platform.EnvPublicAddr: "127.0.0.1:0", platform.EnvInternalAddr: "localhost:0", platform.EnvSignallingAddr: occupied.Addr().String(), platform.EnvDBPath: filepath.Join(t.TempDir(), "falky.db"), platform.EnvAdminSocket: filepath.Join(t.TempDir(), "admin.sock"), platform.EnvLiveKitAPIKey: "test", platform.EnvLiveKitAPISecret: "test-secret"}))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	if err := serve(ctx, cfg, platform.NewLogger(io.Discard, 0)); err == nil || !strings.Contains(err.Error(), "signalling listener") {
		t.Fatalf("occupied guarded listener startup = %v", err)
	}
}
