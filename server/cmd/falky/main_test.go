package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/platform"
)

// syncBuffer is a bytes.Buffer safe for the server's goroutines to write to
// while the test reads it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	body, err := io.ReadAll(res.Body)
	if err := errors.Join(err, res.Body.Close()); err != nil {
		t.Fatalf("GET %s: read body: %v", url, err)
	}
	return res.StatusCode, string(body)
}

func TestServeAnswersOnBothListenersAndStopsCleanly(t *testing.T) {
	var lc net.ListenConfig
	listen := func() net.Listener {
		ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		return ln
	}
	publicLn, internalLn := listen(), listen()
	public, internal := "http://"+publicLn.Addr().String(), "http://"+internalLn.Addr().String()

	var logs syncBuffer
	logger := platform.NewLogger(&logs, 0)
	cfg := platform.Config{DBPath: filepath.Join(t.TempDir(), "falky.db")}
	db, ms, err := openMigrated(t.Context(), cfg, logger)
	if err != nil {
		t.Fatalf("openMigrated: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serveOn(ctx, logger, db, ms, publicLn, internalLn) }()

	if code, body := get(t, internal+"/health/live"); code != http.StatusOK {
		t.Errorf("internal /health/live = %d %s, want 200", code, body)
	}
	if code, body := get(t, internal+"/health/ready"); code != http.StatusOK || !strings.Contains(body, `"database":"ok"`) {
		t.Errorf("internal /health/ready = %d %s, want 200 naming database ok", code, body)
	}
	if code, body := get(t, internal+"/metrics"); code != http.StatusOK || !strings.Contains(body, "go_goroutines") {
		t.Errorf("internal /metrics = %d, want 200 with Go metrics", code)
	}
	for _, path := range []string{"/health/live", "/health/ready", "/metrics"} {
		if code, _ := get(t, public+path); code != http.StatusNotFound {
			t.Errorf("public %s = %d, want 404", path, code)
		}
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveOn after cancel: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveOn did not return after cancel")
	}

	sc := bufio.NewScanner(strings.NewReader(logs.String()))
	lines := 0
	for sc.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(sc.Bytes(), &entry); err != nil {
			t.Errorf("log line is not JSON: %q", sc.Text())
		}
		lines++
	}
	if lines == 0 || !strings.Contains(logs.String(), `"msg":"stopped"`) {
		t.Errorf("logs = %q, want JSON lines ending with stopped", logs.String())
	}
}

func TestServeReadinessFailsWhenTheDatabaseIsGone(t *testing.T) {
	var lc net.ListenConfig
	publicLn, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	internalLn, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	logger := platform.NewLogger(io.Discard, 0)
	db, ms, err := openMigrated(t.Context(), platform.Config{DBPath: filepath.Join(t.TempDir(), "falky.db")}, logger)
	if err != nil {
		t.Fatalf("openMigrated: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serveOn(ctx, logger, db, ms, publicLn, internalLn) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("serveOn: %v", err)
		}
	})

	if code, body := get(t, "http://"+internalLn.Addr().String()+"/health/ready"); code != http.StatusServiceUnavailable ||
		!strings.Contains(body, `"database":"unavailable"`) {
		t.Errorf("/health/ready = %d %s, want 503 naming database unavailable", code, body)
	}
}

func TestMigrateCommandIsIdempotent(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "falky.db")
	getenv := func(k string) string {
		if k == platform.EnvDBPath {
			return dbPath
		}
		return ""
	}
	for i := range 2 {
		var stdout, stderr bytes.Buffer
		if code := run(t.Context(), []string{"migrate"}, getenv, &stdout, &stderr); code != 0 {
			t.Fatalf("migrate run %d: exit %d, stdout %q, stderr %q", i+1, code, stdout.String(), stderr.String())
		}
	}
}

func TestRunRefusesUnknownCommands(t *testing.T) {
	for _, args := range [][]string{nil, {"frobnicate"}, {"serve", "extra"}} {
		var stdout, stderr bytes.Buffer
		if code := run(t.Context(), args, func(string) string { return "" }, &stdout, &stderr); code != 2 {
			t.Errorf("run %q = %d, want 2", args, code)
		}
		if !strings.Contains(stderr.String(), "usage:") {
			t.Errorf("run %q stderr = %q, want usage", args, stderr.String())
		}
	}
}
