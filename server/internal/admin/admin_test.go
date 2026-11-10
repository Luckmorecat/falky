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
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

// newDeps returns the services over a fresh migrated database that already
// has its access link.
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
	ident := identity.New(db, "https://falky.example")
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatalf("EnsureLink: %v", err)
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

func TestTheClientShowsTheCurrentLink(t *testing.T) {
	deps := newDeps(t)
	want, err := deps.Identity.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)

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
	if _, err := admin.NewClient(path).Link(t.Context()); err != nil {
		t.Errorf("client Link over the replaced socket: %v", err)
	}
}

func TestListenRefusesASocketInUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), newDeps(t))

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

func TestTheClientRotatesTheLinkAndEverythingOfTheOldOneEnds(t *testing.T) {
	deps := newDeps(t)
	lk := voicetest.New()
	inVoice := lk.AddParticipant("01JBX7A2K9D4F6H8M0P3R5T7VW", "01JBX6Z8Q3M5W2K7R9T4V1C0DE")
	deps.Voice = newVoice(lk, deps.Identity, deps.Rooms, deps.DB)
	old, err := deps.Identity.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)

	rotated, err := admin.NewClient(path).RotateLink(t.Context())
	if err != nil {
		t.Fatalf("RotateLink: %v", err)
	}
	if rotated == old || !strings.HasPrefix(rotated, "https://falky.example/#k=") {
		t.Errorf("RotateLink = %q, want a new link (was %q)", rotated, old)
	}
	if current, err := deps.Identity.Link(t.Context()); err != nil || current != rotated {
		t.Errorf("Link after RotateLink = %q, %v, want %q", current, err, rotated)
	}
	if got := lk.Removed(); !slices.Equal(got, []voice.Participant{inVoice}) {
		t.Errorf("removed from voice %+v, want %+v", got, inVoice)
	}
}

func TestRotatingTheLinkReportsRequiredVoiceEnforcementFailure(t *testing.T) {
	deps := newDeps(t)
	lk := voicetest.New()
	lk.Fail(errors.New("connection refused"))
	deps.Voice = newVoice(lk, deps.Identity, deps.Rooms, deps.DB)
	var logs strings.Builder
	deps.Logger = platform.NewLogger(&logs, 0)
	old, err := deps.Identity.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	path := filepath.Join(t.TempDir(), "admin.sock")
	stop := serve(t, listen(t, path), deps)

	_, err = admin.NewClient(path).RotateLink(t.Context())
	if err == nil {
		t.Fatal("rotation reported success despite failed media enforcement")
	}
	if current, err := deps.Identity.Link(t.Context()); err != nil || current == old {
		t.Fatalf("committed rotation missing: %v", err)
	}
	stop()
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

func TestOperatorInvitationLifecycleOverOwnerSocket(t *testing.T) {
	deps := newDeps(t)
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)
	c := admin.NewClient(path)
	invite, err := c.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if invite.ID == "" || invite.Link == "" || invite.ExpiresAt.Sub(invite.CreatedAt).Round(time.Second) != 7*24*time.Hour {
		t.Fatal("invalid invitation result")
	}
	invitations, err := c.Invitations(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(invitations) != 1 || invitations[0].ID != invite.ID || invitations[0].Token != "" || invitations[0].Link != "" {
		t.Fatal("operator list leaked bearer or lost invitation")
	}
	if err := c.RevokeInvitation(t.Context(), invite.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.Identity.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: invite.Token, Name: "Alice", BrowserContext: "browser"}); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("revoked invitation remained usable")
	}
}

func TestOperatorRecoveryIssuePreservesAccessAndDisableRejectsIt(t *testing.T) {
	deps := newDeps(t)
	path := filepath.Join(t.TempDir(), "admin.sock")
	serve(t, listen(t, path), deps)
	invite, err := deps.Identity.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ceremony, err := deps.Identity.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: invite.Token, Name: "Alice", BrowserContext: "browser"})
	if err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	account, err := deps.Identity.FinishRegistration(t.Context(), ceremony.ID, "browser", key.Registration(t, ceremony.Creation, "https://falky.example"), "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	c := admin.NewClient(path)
	accounts, err := c.Accounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 || accounts[0].ID != account.Session.Visitor.ID {
		t.Fatal("operator cannot find account ID")
	}
	grant, err := c.IssueRecovery(t.Context(), accounts[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if grant.Link == "" || time.Until(grant.ExpiresAt).Round(time.Minute) != 30*time.Minute {
		t.Fatal("bad recovery link")
	}
	if _, err := deps.Identity.ResolveSession(t.Context(), account.Token); err != nil {
		t.Fatal("issuing recovery revoked account")
	}
	if keys, err := deps.Identity.Passkeys(t.Context(), account.Token); err != nil || len(keys) != 1 {
		t.Fatal("issuing recovery changed credentials")
	}
	if err := c.DisableAccount(t.Context(), accounts[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := deps.Identity.ResolveSession(t.Context(), account.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatal("disabled account session resolved")
	}
	if _, err := c.IssueRecovery(t.Context(), accounts[0].ID); err == nil {
		t.Fatal("disabled account received recovery link")
	}
}
