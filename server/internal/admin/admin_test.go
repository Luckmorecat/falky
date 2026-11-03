package admin_test

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

// newIdentity returns the identity service over a fresh migrated database
// that already has its access link.
func newIdentity(t *testing.T) *identity.Service {
	t.Helper()
	ms, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "falky.db"))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	ident := identity.New(db, "https://falky.example")
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatalf("EnsureLink: %v", err)
	}
	return ident
}

// serve serves the admin handler on ln until the returned stop is called.
func serve(t *testing.T, ln net.Listener, ident *identity.Service) (stop func()) {
	t.Helper()
	srv := &http.Server{
		Handler:           admin.Handler(admin.Deps{Logger: platform.NewLogger(io.Discard, 0), Identity: ident}),
		ReadHeaderTimeout: time.Second,
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	stopped := false
	stop = func() {
		if stopped {
			return
		}
		stopped = true
		if err := srv.Shutdown(context.WithoutCancel(t.Context())); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
		if err := <-done; !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("Serve: %v", err)
		}
	}
	t.Cleanup(stop)
	return stop
}

func listen(t *testing.T, path string) net.Listener {
	t.Helper()
	ln, err := admin.Listen(t.Context(), path)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	return ln
}

// staleSocket leaves a socket file at path that nobody listens on, as a server
// that was killed does.
func staleSocket(t *testing.T, path string) {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := ln.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestTheClientShowsTheCurrentLink(t *testing.T) {
	ident := newIdentity(t)
	want, err := ident.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), ident)

	client := admin.NewClient(path)
	for i := range 2 {
		got, err := client.Link(t.Context())
		if err != nil {
			t.Fatalf("client Link %d: %v", i+1, err)
		}
		if got != want {
			t.Errorf("client Link %d = %q, want %q", i+1, got, want)
		}
	}
}

func TestTheSocketIsOwnerOnlyAndRemovedOnShutdown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	stop := serve(t, listen(t, path), newIdentity(t))

	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("Lstat: %v", err)
	}
	if fi.Mode().Type() != fs.ModeSocket || fi.Mode().Perm() != 0o600 {
		t.Errorf("socket mode = %v, want a socket with permissions 0600", fi.Mode())
	}

	stop()
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Lstat after shutdown = %v, want the socket removed", err)
	}
}

func TestListenReplacesAStaleSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	staleSocket(t, path)

	serve(t, listen(t, path), newIdentity(t))
	if _, err := admin.NewClient(path).Link(t.Context()); err != nil {
		t.Errorf("client Link over the replaced socket: %v", err)
	}
}

func TestListenRefusesASocketInUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), newIdentity(t))

	if ln, err := admin.Listen(t.Context(), path); err == nil {
		_ = ln.Close()
		t.Fatal("second Listen = nil error, want a refusal")
	}
	if _, err := admin.NewClient(path).Link(t.Context()); err != nil {
		t.Errorf("client Link after the refused Listen: %v", err)
	}
}

func TestListenLeavesOtherFilesAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if ln, err := admin.Listen(t.Context(), path); err == nil {
		_ = ln.Close()
		t.Fatal("Listen over a regular file = nil error, want a refusal")
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "keep" {
		t.Errorf("file after Listen = %q, %v, want it unchanged", body, err)
	}
}

func TestTheClientSaysWhenNoServerIsRunning(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "stale.sock")
	staleSocket(t, stale)

	for name, path := range map[string]string{
		"no socket":    filepath.Join(dir, "missing.sock"),
		"stale socket": stale,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := admin.NewClient(path).Link(t.Context())
			if !errors.Is(err, admin.ErrNotRunning) || !strings.Contains(err.Error(), path) {
				t.Errorf("client Link = %v, want ErrNotRunning naming %s", err, path)
			}
		})
	}
}

func TestUnknownAdminRequestsAreRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), newIdentity(t))

	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
	}}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, "http://falky/link", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST /link: %v", err)
	}
	body, err := io.ReadAll(res.Body)
	if err := errors.Join(err, res.Body.Close()); err != nil {
		t.Fatalf("read body: %v", err)
	}
	if res.StatusCode == http.StatusOK || !strings.Contains(string(body), `"error"`) {
		t.Errorf("POST /link = %d %s, want a refusal with an error body", res.StatusCode, body)
	}
}
