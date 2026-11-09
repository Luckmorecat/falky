package voice_test

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

func TestDurableGrantSurvivesDatabaseReopenAndUnknownTokensFailClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "voice.db")
	logger := platform.NewLogger(io.Discard, 0)
	db, err := platform.OpenDB(t.Context(), path, logger)
	if err != nil {
		t.Fatal(err)
	}
	ms, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations(), voice.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Migrate(t.Context(), ms); err != nil {
		t.Fatal(err)
	}
	ident := identity.New(db, "https://falky.example")
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatal(err)
	}
	link, err := ident.Link(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := ident.Enter(t.Context(), link[len("https://falky.example/#k="):], "Bob")
	if err != nil {
		t.Fatal(err)
	}
	session, err := ident.ResolveSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	rs := rooms.New(db)
	room, err := rs.Create(t.Context(), "Voice")
	if err != nil {
		t.Fatal(err)
	}
	lk := voicetest.New()
	cfg := voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8}
	s := voice.New(lk, ident, rs, cfg, voice.WithDB(db))
	creds, err := s.JoinSession(t.Context(), session, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	s.CloseSignalling()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = platform.OpenDB(t.Context(), path, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	ident = identity.New(db, "https://falky.example")
	s = voice.New(lk, ident, rooms.New(db), cfg, voice.WithDB(db))
	s.ConfigureAdmission(&sync.Mutex{}, ident.ValidateSession, "https://falky.example")
	guard := s.Signalling("http://127.0.0.1:1")
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/rtc/validate?access_token="+creds.Token, nil)
	result := httptest.NewRecorder()
	guard.ServeHTTP(result, request)
	if result.Code != http.StatusBadGateway {
		t.Fatalf("persisted grant admission = %d, want admitted upstream (502)", result.Code)
	}
	unknown := voice.New(lk, ident, rooms.New(db), cfg)
	unknown.ConfigureAdmission(&sync.Mutex{}, ident.ValidateSession, "https://falky.example")
	result = httptest.NewRecorder()
	unknown.Signalling("http://127.0.0.1:1").ServeHTTP(result, request)
	if result.Code != http.StatusForbidden {
		t.Fatalf("missing grant admission = %d, want 403", result.Code)
	}
}

func TestCleanupRetriesAfterDeletedSessionAndDatabaseRestartEvenWhenListingIsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cleanup.db")
	logger := platform.NewLogger(io.Discard, 0)
	db, err := platform.OpenDB(t.Context(), path, logger)
	if err != nil {
		t.Fatal(err)
	}
	ms, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations(), voice.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatal(err)
	}
	ident := identity.New(db, "https://falky.example")
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatal(err)
	}
	link, err := ident.Link(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_, cookie, err := ident.Enter(t.Context(), strings.TrimPrefix(link, "https://falky.example/#k="), "Bob")
	if err != nil {
		t.Fatal(err)
	}
	session, err := ident.ResolveSession(t.Context(), cookie)
	if err != nil {
		t.Fatal(err)
	}
	rs := rooms.New(db)
	room, err := rs.Create(t.Context(), "Voice")
	if err != nil {
		t.Fatal(err)
	}
	lk := &retryLiveKit{LiveKit: voicetest.New()}
	cfg := voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8}
	s := voice.New(lk, ident, rs, cfg, voice.WithDB(db))
	creds, err := s.JoinSession(t.Context(), session, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	lk.fail = true
	effects, err := ident.Logout(t.Context(), cookie)
	if err != nil {
		t.Fatal(err)
	}
	if len(effects.RevokedSessions) != 1 {
		t.Fatal("logout did not delete the original session")
	}
	if err := s.Revoke(t.Context(), func(other identity.Session) bool { return other.ID == session.ID }); err == nil {
		t.Fatal("expected immediate cleanup failure")
	}
	s.CloseSignalling()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = platform.OpenDB(t.Context(), path, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	ident = identity.New(db, "https://falky.example")
	s = voice.New(lk, ident, rooms.New(db), cfg, voice.WithDB(db))
	// No participant appears in the listing. The durable record still requires removal.
	lk.fail = false
	lk.attempts = nil
	if err := s.CleanupGrants(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(lk.attempts, []string{creds.GrantID}) {
		t.Fatalf("cleanup attempts=%v, want exact absent transport", lk.attempts)
	}
	lk.attempts = nil
	if err := s.CleanupGrants(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(lk.attempts) != 0 {
		t.Fatalf("successful cleanup retained obsolete grant: %v", lk.attempts)
	}
}

type retryLiveKit struct {
	mu sync.Mutex
	*voicetest.LiveKit
	fail            bool
	failedTransport string
	attempts        []string
}

func (lk *retryLiveKit) RemoveParticipant(ctx context.Context, room, transport string) error {
	lk.mu.Lock()
	lk.attempts = append(lk.attempts, transport)
	fail := lk.fail || transport == lk.failedTransport
	lk.mu.Unlock()
	if fail {
		return errors.New("media unavailable")
	}
	return lk.LiveKit.RemoveParticipant(ctx, room, transport)
}

func TestVoiceMigrationUpgradesExistingGrantsWithoutSessionCascade(t *testing.T) {
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "constraints.db"), platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	legacy, err := fs.ReadFile(voice.Migrations(), "0010_voice_grants.sql")
	if err != nil {
		t.Fatal(err)
	}
	ms, err := platform.LoadMigrations(identity.Migrations(), fstest.MapFS{"0010_voice_grants.sql": &fstest.MapFile{Data: legacy}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatal(err)
	}
	insert := func(transport string, revoked int) error {
		return db.Write(t.Context(), func(tx *sql.Tx) error {
			_, err := tx.ExecContext(t.Context(), `INSERT INTO voice_grants(transport,session_id,identity_id,session_kind,generation,room_id,revoked) VALUES (?,?,?,?,?,?,?)`, transport, "deleted-session", "identity", "guest", 1, "room", revoked)
			return err
		})
	}
	if err := insert("identity.first", 0); err != nil {
		t.Fatal(err)
	}
	if err := insert("identity.second", 0); err == nil {
		t.Fatal("legacy schema admitted two active grants")
	}
	ms, err = platform.LoadMigrations(identity.Migrations(), voice.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if n, err := db.Migrate(t.Context(), ms); err != nil || n != 1 {
		t.Fatalf("forward upgrade: %d %v", n, err)
	}
	if err := insert("identity.second", 0); err != nil {
		t.Fatal("new schema refused independent grant:", err)
	}
	var count int
	if err := db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM voice_grants WHERE transport='identity.first' AND revoked=0").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("upgrade lost existing grant")
	}

	if err := insert("identity.pending", 1); err != nil {
		t.Fatal("revoked cleanup must survive a deleted session:", err)
	}
	if err := insert("identity.first", 1); err == nil {
		t.Fatal("database reused a transport")
	}
}

func TestCleanupContinuesAfterIndividualFailureAndLateRevokedCleanupCannotHitReplacement(t *testing.T) {
	lk := &retryLiveKit{LiveKit: voicetest.New()}
	acc := newAccess(bob, alice)
	s := voice.New(lk, acc, acc, voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8})
	session := identity.Session{ID: "bob-session", Kind: identity.Guest, Visitor: bob, Generation: 1}
	old, err := s.JoinSession(t.Context(), session, roomA)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.JoinSession(t.Context(), identity.Session{ID: "alice-session", Kind: identity.Guest, Visitor: alice, Generation: 1}, roomA)
	if err != nil {
		t.Fatal(err)
	}
	lk.failedTransport = old.GrantID
	if err := s.Revoke(t.Context(), func(identity.Session) bool { return true }); err == nil {
		t.Fatal("expected one removal failure")
	}
	if !slices.Contains(lk.attempts, other.GrantID) {
		t.Fatal("one failure starved another record")
	}
	lk.failedTransport = ""
	replacement, err := s.JoinSession(t.Context(), session, roomA)
	if err != nil {
		t.Fatal(err)
	}
	participant := lk.AddParticipant(roomA, replacement.GrantID)
	if err := s.CleanupGrants(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := s.ReceiveWebhook(signed(t, voicetest.Joined(voice.Participant{Room: roomA, Identity: old.GrantID, SID: "late"}), testKey, testSecret)); err != nil {
		t.Fatal(err)
	}
	if err := s.ReceiveWebhook(signed(t, voicetest.Left(voice.Participant{Room: roomA, Identity: old.GrantID, SID: "late"}), testKey, testSecret)); err != nil {
		t.Fatal(err)
	}
	if err := s.CleanupGrants(t.Context()); err != nil {
		t.Fatal(err)
	}
	listed, err := lk.Participants(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(listed, []voice.Participant{participant}) {
		t.Fatalf("late old-grant work hit replacement: %v", listed)
	}
}

func TestFailedOldCleanupDoesNotGateIndependentCredentials(t *testing.T) {
	for _, kind := range []identity.Kind{identity.Guest, identity.Account} {
		t.Run(string(kind), func(t *testing.T) {
			lk := &retryLiveKit{LiveKit: voicetest.New()}
			acc := newAccess(bob)
			s := voice.New(lk, acc, acc, voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8})
			session := identity.Session{ID: "browser", Kind: kind, Visitor: bob, Generation: 1}
			first, err := s.JoinSession(t.Context(), session, roomA)
			if err != nil {
				t.Fatal(err)
			}
			lk.failedTransport = first.GrantID
			if err := s.FenceSessions(t.Context(), func(candidate identity.Session) bool { return candidate.ID == session.ID }); err != nil {
				t.Fatal(err)
			}
			if err := s.CleanupGrants(t.Context()); err == nil {
				t.Fatal("expected security cleanup failure")
			}
			session.ID = "replacement-browser"
			for range 2 {
				creds, err := s.JoinSession(t.Context(), session, roomA)
				if err != nil || creds.Token == "" || creds.GrantID == first.GrantID {
					t.Fatalf("independent Join blocked by cleanup: %+v %v", creds, err)
				}
			}
			lk.failedTransport = ""
			next, err := s.JoinSession(t.Context(), session, roomA)
			if err != nil {
				t.Fatal(err)
			}
			if next.GrantID == first.GrantID {
				t.Fatal("replacement reused transport")
			}
		})
	}
}

func TestOneBlockedCleanupCannotStarveOtherRevokedGrants(t *testing.T) {
	lk := &blockedRemoval{LiveKit: voicetest.New(), entered: make(chan struct{}), release: make(chan struct{}), otherRemoved: make(chan struct{})}
	acc := newAccess(bob, alice)
	s := voice.New(lk, acc, acc, voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8})
	first, err := s.JoinSession(t.Context(), identity.Session{ID: "bob", Kind: identity.Guest, Visitor: bob}, roomA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.JoinSession(t.Context(), identity.Session{ID: "alice", Kind: identity.Guest, Visitor: alice}, roomA); err != nil {
		t.Fatal(err)
	}
	lk.target = first.GrantID
	if err := s.FenceSessions(t.Context(), func(identity.Session) bool { return true }); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.CleanupGrants(t.Context()) }()
	unblock := sync.OnceFunc(func() { close(lk.release) })
	defer unblock()
	select {
	case <-lk.entered:
	case <-time.After(time.Second):
		t.Fatal("cleanup never attempted blocked record")
	}
	select {
	case <-lk.otherRemoved:
	case <-time.After(time.Second):
		t.Fatal("blocked record starved another cleanup")
	}
	// The blocked record remains pending when its individual operation fails.
	lk.finish = errors.New("still unavailable")
	unblock()
	if err := <-done; err == nil {
		t.Fatal("expected retained cleanup error")
	}
}

type blockedRemoval struct {
	*voicetest.LiveKit
	target                         string
	entered, release, otherRemoved chan struct{}
	finish                         error
}

func (lk *blockedRemoval) RemoveParticipant(ctx context.Context, room, transport string) error {
	if transport == lk.target {
		close(lk.entered)
		select {
		case <-lk.release:
			return lk.finish
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	close(lk.otherRemoved)
	return lk.LiveKit.RemoveParticipant(ctx, room, transport)
}
