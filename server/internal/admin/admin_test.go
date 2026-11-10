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
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

// newDeps returns the services over a fresh migrated database whose access
// password is set.
func newDeps(t *testing.T) admin.Deps {
	t.Helper()
	ms, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations(), voice.Migrations())
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "falky.db"), platform.NewLogger(io.Discard, 0))
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
	ident := identity.New(db, "https://falky.example", identity.WithPasswordCost(identity.PasswordCost{Time: 1, MemoryKiB: 64}))
	if err := ident.SetAccessPassword(t.Context(), accessPassword); err != nil {
		t.Fatalf("SetAccessPassword: %v", err)
	}
	rs := rooms.New(db)
	return admin.Deps{
		Logger: platform.NewLogger(io.Discard, 0), Identity: ident, Rooms: rs,
		Voice: newVoice(voicetest.New(), ident, rs, db),
		DB:    db, SnapshotDir: filepath.Join(t.TempDir(), "snapshots"),
	}
}

// newVoice returns the voice service over lk.
func newVoice(lk voice.LiveKit, ident *identity.Service, rs *rooms.Service, db *platform.DB) *voice.Service {
	return voice.New(lk, ident, rs, voice.Config{URL: "wss://falky.example", APIKey: "falky", APISecret: "a-secret", RoomCap: 8}, voice.WithDB(db))
}

// serve serves the admin handler on ln until the returned stop is called.
func serve(t *testing.T, ln net.Listener, deps admin.Deps) (stop func()) {
	t.Helper()
	if deps.Lifecycle == nil {
		deps.Lifecycle = &httpapi.Lifecycle{Enforce: httpapi.Enforcer(httpapi.Events{}, deps.Voice)}
	}
	srv := &http.Server{
		Handler:           admin.Handler(deps),
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

const accessPassword = "shared secret phrase"

// register registers name on deps' identity service and returns the enrollment.
func register(t *testing.T, deps admin.Deps, login, name string) identity.Enrollment {
	t.Helper()
	pass, err := deps.Identity.PassAccess(t.Context(), accessPassword)
	if err != nil {
		t.Fatal(err)
	}
	e, err := deps.Identity.Register(t.Context(), identity.RegistrationInput{AccessToken: pass, Login: login, Password: "correct horse battery", Name: name})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestTheClientSetsTheAccessPassword(t *testing.T) {
	deps := newDeps(t)
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)
	old, err := deps.Identity.PassAccess(t.Context(), accessPassword)
	if err != nil {
		t.Fatal(err)
	}
	account := register(t, deps, "ann", "Ann")

	client := admin.NewClient(path)
	if err := client.SetAccessPassword(t.Context(), "short"); err == nil || !strings.Contains(err.Error(), "8 to 128") {
		t.Fatalf("SetAccessPassword(short) = %v, want the length rule", err)
	}
	if err := client.SetAccessPassword(t.Context(), "a new shared secret"); err != nil {
		t.Fatalf("SetAccessPassword: %v", err)
	}
	if passed, _ := deps.Identity.AccessPassed(t.Context(), old); passed {
		t.Error("a pass for the old access password still admits")
	}
	if _, err := deps.Identity.PassAccess(t.Context(), "a new shared secret"); err != nil {
		t.Errorf("the new access password is refused: %v", err)
	}
	if _, err := deps.Identity.ResolveSession(t.Context(), account.Token); err != nil {
		t.Errorf("changing the access password ended a session: %v", err)
	}
}

func TestTheSocketIsOwnerOnlyAndRemovedOnShutdown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	stop := serve(t, listen(t, path), newDeps(t))

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

	serve(t, listen(t, path), newDeps(t))
	if _, err := admin.NewClient(path).Accounts(t.Context()); err != nil {
		t.Errorf("client Accounts over the replaced socket: %v", err)
	}
}

func TestListenRefusesASocketInUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), newDeps(t))

	if ln, err := admin.Listen(t.Context(), path); err == nil {
		_ = ln.Close()
		t.Fatal("second Listen = nil error, want a refusal")
	}
	if _, err := admin.NewClient(path).Accounts(t.Context()); err != nil {
		t.Errorf("client Accounts after the refused Listen: %v", err)
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
			_, err := admin.NewClient(path).Accounts(t.Context())
			if !errors.Is(err, admin.ErrNotRunning) || !strings.Contains(err.Error(), path) {
				t.Errorf("client Accounts = %v, want ErrNotRunning naming %s", err, path)
			}
		})
	}
}

func TestUnknownAdminRequestsAreRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), newDeps(t))

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

func TestTheClientCreatesAndRenamesRooms(t *testing.T) {
	deps := newDeps(t)
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)
	client := admin.NewClient(path)

	id, err := client.CreateRoom(t.Context(), " Lounge ")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	if err := client.RenameRoom(t.Context(), id, "Living room"); err != nil {
		t.Fatalf("RenameRoom: %v", err)
	}
	got, err := deps.Rooms.List(t.Context())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if want := []rooms.Room{{ID: id, Name: "Living room"}}; !slices.Equal(got, want) {
		t.Errorf("List = %+v, want %+v", got, want)
	}
}

func TestTheClientReportsWhyARoomChangeIsRefused(t *testing.T) {
	deps := newDeps(t)
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)
	client := admin.NewClient(path)
	lounge, err := deps.Rooms.Create(t.Context(), "Lounge")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	games, err := deps.Rooms.Create(t.Context(), "Games")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if _, err := client.CreateRoom(t.Context(), "lounge"); err == nil || !strings.Contains(err.Error(), "another room has this name") {
		t.Errorf("CreateRoom with a taken name = %v, want it refused as taken", err)
	}
	if err := client.RenameRoom(t.Context(), games.ID, " LOUNGE"); err == nil || !strings.Contains(err.Error(), "another room has this name") {
		t.Errorf("RenameRoom to a taken name = %v, want it refused as taken", err)
	}
	if _, err := client.CreateRoom(t.Context(), " "); err == nil || !strings.Contains(err.Error(), "invalid name") {
		t.Errorf("CreateRoom with an empty name = %v, want it refused as invalid", err)
	}
	unknown := "01JBX6Z8Q3M5W2K7R9T4V1C0DE"
	if err := client.RenameRoom(t.Context(), unknown, "Den"); err == nil || !strings.Contains(err.Error(), unknown) {
		t.Errorf("RenameRoom of an unknown room = %v, want a refusal naming %s", err, unknown)
	}

	got, err := deps.Rooms.List(t.Context())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if want := []rooms.Room{lounge, games}; !slices.Equal(got, want) {
		t.Errorf("List after the refusals = %+v, want %+v", got, want)
	}
}

func TestDisablingAnAccountEndsItsVoiceAndReportsFailedEnforcement(t *testing.T) {
	deps := newDeps(t)
	account := register(t, deps, "ann", "Ann")
	room, err := deps.Rooms.Create(t.Context(), "Lounge")
	if err != nil {
		t.Fatal(err)
	}
	lk := voicetest.New()
	deps.Voice = newVoice(lk, deps.Identity, deps.Rooms, deps.DB)
	lifecycle := &httpapi.Lifecycle{Enforce: httpapi.Enforcer(httpapi.Events{}, deps.Voice)}
	deps.Lifecycle = lifecycle
	lifecycle.Lock()
	creds, err := deps.Voice.JoinSession(t.Context(), account.Session, room.ID)
	lifecycle.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	inVoice := lk.AddParticipant(room.ID, creds.GrantID)
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)

	lk.Fail(errors.New("connection refused"))
	if err := admin.NewClient(path).DisableAccount(t.Context(), "ann"); err == nil {
		t.Fatal("disabling reported success despite failed media enforcement")
	}
	if _, err := deps.Identity.ResolveSession(t.Context(), account.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("the committed disable is missing: %v", err)
	}
	lk.Fail(nil)
	if err := admin.NewClient(path).DisableAccount(t.Context(), "ann"); err != nil {
		t.Fatalf("DisableAccount again: %v", err)
	}
	if got := lk.Removed(); !slices.Contains(got, inVoice) {
		t.Errorf("removed from voice %+v, want %+v", got, inVoice)
	}
}

func TestTheClientTakesAnOwnerOnlySnapshotIntoTheSnapshotDirectory(t *testing.T) {
	deps := newDeps(t)
	lounge, err := deps.Rooms.Create(t.Context(), "Lounge")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)

	snapshot, err := admin.NewClient(path).Snapshot(t.Context())
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if dir := filepath.Dir(snapshot); dir != deps.SnapshotDir {
		t.Errorf("snapshot %s is in %s, want %s", snapshot, dir, deps.SnapshotDir)
	}
	if !regexp.MustCompile(`^falky-\d{8}T\d{6}Z\.db$`).MatchString(filepath.Base(snapshot)) {
		t.Errorf("snapshot name %q, want falky-<UTC time>.db", filepath.Base(snapshot))
	}
	for p, want := range map[string]fs.FileMode{deps.SnapshotDir: 0o700, snapshot: 0o600} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatalf("Stat: %v", err)
		}
		if fi.Mode().Perm() != want {
			t.Errorf("%s mode = %v, want %v", p, fi.Mode().Perm(), want)
		}
	}

	db, err := platform.OpenDB(t.Context(), snapshot, platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatalf("open the snapshot: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	got, err := rooms.New(db).List(t.Context())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if want := []rooms.Room{lounge}; !slices.Equal(got, want) {
		t.Errorf("rooms in the snapshot = %+v, want %+v", got, want)
	}
}

func TestOperatorRecoveryIssuePreservesAccessAndDisableRejectsIt(t *testing.T) {
	deps := newDeps(t)
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)
	account := register(t, deps, "alice", "Alice")
	c := admin.NewClient(path)
	accounts, err := c.Accounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 || accounts[0].ID != account.Session.Visitor.ID || accounts[0].Login != "alice" || accounts[0].Name != "Alice" {
		t.Fatalf("accounts = %+v", accounts)
	}
	grant, err := c.IssueRecovery(t.Context(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(grant.Link, "&account=alice") || time.Until(grant.ExpiresAt).Round(time.Minute) != 30*time.Minute {
		t.Fatalf("bad recovery link %+v", grant)
	}
	if _, err := deps.Identity.ResolveSession(t.Context(), account.Token); err != nil {
		t.Fatal("issuing recovery revoked account")
	}
	if err := c.DisableAccount(t.Context(), accounts[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.Identity.ResolveSession(t.Context(), account.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatal("disabled account session resolved")
	}
	if _, err := c.IssueRecovery(t.Context(), "alice"); err == nil {
		t.Fatal("disabled account received recovery link")
	}
	if err := c.EnableAccount(t.Context(), "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.IssueRecovery(t.Context(), "alice"); err != nil {
		t.Fatalf("enabled account cannot recover: %v", err)
	}
	if err := c.DisableAccount(t.Context(), "nobody"); err == nil {
		t.Fatal("disabling an unknown account succeeded")
	}
}
