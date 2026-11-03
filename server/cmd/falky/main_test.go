package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/admin"
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

// newListeners listens on loopback for the public and internal listeners and
// on an admin socket at socketPath.
func newListeners(t *testing.T, socketPath string) listeners {
	t.Helper()
	var lc net.ListenConfig
	tcp := func() net.Listener {
		ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		return ln
	}
	adminLn, err := admin.Listen(t.Context(), socketPath)
	if err != nil {
		t.Fatalf("admin listen: %v", err)
	}
	return listeners{public: tcp(), internal: tcp(), admin: adminLn}
}

func TestServeAnswersOnItsListenersAndStopsCleanly(t *testing.T) {
	ls := newListeners(t, filepath.Join(t.TempDir(), "admin.sock"))
	public, internal := "http://"+ls.public.Addr().String(), "http://"+ls.internal.Addr().String()

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
	go func() { done <- serveOn(ctx, logger, cfg, db, ms, ls) }()

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
	ls := newListeners(t, filepath.Join(t.TempDir(), "admin.sock"))
	logger := platform.NewLogger(io.Discard, 0)
	cfg := platform.Config{DBPath: filepath.Join(t.TempDir(), "falky.db")}
	db, ms, err := openMigrated(t.Context(), cfg, logger)
	if err != nil {
		t.Fatalf("openMigrated: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serveOn(ctx, logger, cfg, db, ms, ls) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("serveOn: %v", err)
		}
	})

	if code, body := get(t, "http://"+ls.internal.Addr().String()+"/health/ready"); code != http.StatusServiceUnavailable ||
		!strings.Contains(body, `"database":"unavailable"`) {
		t.Errorf("/health/ready = %d %s, want 503 naming database unavailable", code, body)
	}
}

func TestMigrateCommandIsIdempotentAndCreatesTheLinkOnce(t *testing.T) {
	getenv := env(map[string]string{platform.EnvDBPath: filepath.Join(t.TempDir(), "falky.db")})
	for i, wantCreated := range []bool{true, false} {
		var stdout, stderr bytes.Buffer
		if code := run(t.Context(), []string{"migrate"}, getenv, &stdout, &stderr); code != 0 {
			t.Fatalf("migrate run %d: exit %d, stdout %q, stderr %q", i+1, code, stdout.String(), stderr.String())
		}
		if created := strings.Contains(stdout.String(), "access link created"); created != wantCreated {
			t.Errorf("migrate run %d: link created = %v, want %v; logs %q", i+1, created, wantCreated, stdout.String())
		}
	}
}

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

// startServer serves the database at cfg.DBPath, with its admin socket at
// cfg.AdminSocket, logging to logs, until the returned stop is called.
func startServer(t *testing.T, cfg platform.Config, logs io.Writer) (stop func()) {
	t.Helper()
	logger := platform.NewLogger(logs, 0)
	db, ms, err := openMigrated(t.Context(), cfg, logger)
	if err != nil {
		t.Fatalf("openMigrated: %v", err)
	}
	ls := newListeners(t, cfg.AdminSocket)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serveOn(ctx, logger, cfg, db, ms, ls) }()
	stopped := false
	stop = func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		if err := errors.Join(<-done, db.Close()); err != nil {
			t.Errorf("server: %v", err)
		}
	}
	t.Cleanup(stop)
	return stop
}

// runLinkShow runs falky link show and returns its exit code and output.
func runLinkShow(t *testing.T, getenv func(string) string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code = run(t.Context(), []string{"link", "show"}, getenv, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestLinkShowPrintsTheSameLinkAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:       filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket:  filepath.Join(dir, "admin.sock"),
		platform.EnvPublicOrigin: "https://falky.example",
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	var logs syncBuffer
	stop := startServer(t, cfg, &logs)

	code, link, stderr := runLinkShow(t, env(vars))
	if code != 0 || !strings.HasPrefix(link, "https://falky.example/#k=") || !strings.HasSuffix(link, "\n") {
		t.Fatalf("link show = exit %d, stdout %q, stderr %q; want 0 and the link on one line", code, link, stderr)
	}
	if code, again, _ := runLinkShow(t, env(vars)); code != 0 || again != link {
		t.Errorf("second link show = exit %d, %q, want 0, %q", code, again, link)
	}

	stop()
	if _, err := os.Lstat(cfg.AdminSocket); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("admin socket after shutdown: Lstat = %v, want it removed", err)
	}
	startServer(t, cfg, &logs)
	if code, again, _ := runLinkShow(t, env(vars)); code != 0 || again != link {
		t.Errorf("link show after restart = exit %d, %q, want 0, %q", code, again, link)
	}

	secret := strings.TrimSpace(strings.TrimPrefix(link, "https://falky.example/#k="))
	if strings.Contains(logs.String(), secret) {
		t.Errorf("server logs contain the link secret: %q", logs.String())
	}
}

func TestLinkShowFailsWhenNoServerIsRunning(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "admin.sock")
	code, stdout, stderr := runLinkShow(t, env(map[string]string{platform.EnvAdminSocket: socket}))
	if code == 0 || stdout != "" || !strings.Contains(stderr, "not running") || !strings.Contains(stderr, socket) {
		t.Errorf("link show = exit %d, stdout %q, stderr %q; want non-zero, no link, and a message naming %s", code, stdout, stderr, socket)
	}
}

func TestRunRefusesUnknownCommands(t *testing.T) {
	for _, args := range [][]string{nil, {"frobnicate"}, {"serve", "extra"}, {"link"}, {"link", "rotate"}, {"link", "show", "extra"}} {
		var stdout, stderr bytes.Buffer
		if code := run(t.Context(), args, func(string) string { return "" }, &stdout, &stderr); code != 2 {
			t.Errorf("run %q = %d, want 2", args, code)
		}
		if !strings.Contains(stderr.String(), "usage:") {
			t.Errorf("run %q stderr = %q, want usage", args, stderr.String())
		}
	}
}
