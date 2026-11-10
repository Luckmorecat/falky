package voice_test

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
	"github.com/livekit/protocol/auth"
)

func openLeaseDB(t *testing.T, path string, migrations fs.FS) *platform.DB {
	t.Helper()
	db, err := platform.OpenDB(t.Context(), path, platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ms, err := platform.LoadMigrations(migrations)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatal(err)
	}
	return db
}

func durableLeaseService(db *platform.DB, lk voice.LiveKit, clock *idleClock) *voice.Service {
	a := newAccess(bob)
	s := voice.New(lk, a, a, voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8}, voice.WithDB(db), voice.WithClock(clock.read))
	s.ConfigureAdmission(&sync.Mutex{}, func(_ context.Context, session identity.Session) (identity.Session, error) { return session, nil }, "https://falky.example")
	return s
}

func leaseSession() identity.Session {
	return identity.Session{ID: "browser", Kind: identity.Guest, Generation: 1, Visitor: bob}
}

func TestIdleDeadlineSurvivesReopenAndFailedCleanupRetainsExactTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "idle.db")
	db := openLeaseDB(t, path, voice.Migrations())
	lk := &retryLiveKit{LiveKit: voicetest.New()}
	clock := &idleClock{now: time.Now()}
	s := durableLeaseService(db, lk, clock)
	old, err := s.JoinSession(t.Context(), leaseSession(), roomA)
	if err != nil {
		t.Fatal(err)
	}
	// New unused grants persist the issue-time absence immediately.
	clock.advance(6 * time.Minute)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openLeaseDB(t, path, voice.Migrations())
	s = durableLeaseService(db, lk, clock)
	clock.advance(4 * time.Minute)
	if got := leaseStatus(t, s, old.Token); got != 403 {
		t.Fatalf("restart renewed idle deadline: %d", got)
	}
	lk.failedTransport = old.GrantID
	if err := s.Refresh(t.Context()); err == nil {
		t.Fatal("expected failed targeted cleanup")
	}
	fresh, err := s.JoinSession(t.Context(), leaseSession(), roomA)
	if err != nil {
		t.Fatal(err)
	}
	participant := lk.AddParticipant(roomA, fresh.GrantID)
	// Once fenced, even fabricated late presence cannot reactivate the old grant.
	if got := leaseStatus(t, s, old.Token); got != 403 {
		t.Fatalf("failed cleanup reactivated target: %d", got)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openLeaseDB(t, path, voice.Migrations())
	s = durableLeaseService(db, lk, clock)
	if err := s.CleanupGrants(t.Context()); err == nil {
		t.Fatal("restart forgot failed cleanup")
	}
	lk.failedTransport = ""
	if err := s.CleanupGrants(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, old.Token); got != 403 {
		t.Fatalf("retired target resurrected: %d", got)
	}
	listed, err := lk.Participants(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0] != participant {
		t.Fatalf("old cleanup hit fresh grant: %v", listed)
	}
}

func TestLegacyNullLeaseStartsOnlyAtFirstSuccessfulAbsence(t *testing.T) {
	for _, initiallyPresent := range []bool{false, true} {
		t.Run(map[bool]string{false: "absent", true: "present"}[initiallyPresent], func(t *testing.T) {
			legacy := fstest.MapFS{}
			for _, name := range []string{"0010_voice_grants.sql", "0011_independent_voice_connections.sql"} {
				data, err := fs.ReadFile(voice.Migrations(), name)
				if err != nil {
					t.Fatal(err)
				}
				legacy[name] = &fstest.MapFile{Data: data}
			}
			path := filepath.Join(t.TempDir(), "legacy.db")
			db := openLeaseDB(t, path, legacy)
			transport := bob.ID + ".legacy"
			if err := db.Write(t.Context(), func(tx *sql.Tx) error {
				_, err := tx.ExecContext(t.Context(), `INSERT INTO voice_grants(transport,session_id,identity_id,session_kind,generation,room_id) VALUES (?,?,?,?,?,?)`, transport, "browser", bob.ID, "guest", 1, roomA)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			db = openLeaseDB(t, path, voice.Migrations())
			clock := &idleClock{now: time.Now()}
			lk := voicetest.New()
			s := durableLeaseService(db, lk, clock)
			token, err := auth.NewAccessToken(testKey, testSecret).SetIdentity(transport).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: roomA}).ToJWT()
			if err != nil {
				t.Fatal(err)
			}
			if initiallyPresent {
				lk.AddParticipant(roomA, transport)
			}
			clock.advance(24 * time.Hour)
			lk.Fail(errors.New("outage"))
			if err := s.Refresh(t.Context()); !errors.Is(err, voice.ErrUnavailable) {
				t.Fatal(err)
			}
			if got := leaseStatus(t, s, token); got != 502 {
				t.Fatalf("legacy unknown deadline invented: %d", got)
			}
			lk.Fail(nil)
			if err := s.Refresh(t.Context()); err != nil {
				t.Fatal(err)
			}
			clock.advance(10 * time.Minute)
			want := 403
			if initiallyPresent {
				want = 502
			}
			if got := leaseStatus(t, s, token); got != want {
				t.Fatalf("legacy absence=%t: %d", !initiallyPresent, got)
			}
		})
	}
}

func TestSuccessfulUpstreamAdmissionFailsClosedWhenLeaseWriteFails(t *testing.T) {
	db := openLeaseDB(t, filepath.Join(t.TempDir(), "write.db"), voice.Migrations())
	clock := &idleClock{now: time.Now()}
	lk := voicetest.New()
	s := durableLeaseService(db, lk, clock)
	guard, fixture := leaseGuard(t, s, lk)
	creds, err := s.JoinSession(t.Context(), leaseSession(), roomA)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := fixture.block(false)
	defer release()
	done := make(chan int, 1)
	go func() {
		ws, res, _ := websocket.Dial(t.Context(), guard.URL+"/rtc?access_token="+url.QueryEscape(creds.Token), nil)
		if ws != nil {
			_ = ws.CloseNow()
		}
		status := 0
		if res != nil {
			status = res.StatusCode
			if res.Body != nil {
				_ = res.Body.Close()
			}
		}
		done <- status
	}()
	<-entered
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	release()
	if got := <-done; got != http.StatusServiceUnavailable {
		t.Fatalf("downstream exposed admission before durable clear: %d", got)
	}
}

func TestObservedAbsenceSurvivesRestartAndOutageWithoutDestroyingPresence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "observed.db")
	db := openLeaseDB(t, path, voice.Migrations())
	clock := &idleClock{now: time.Now()}
	lk := voicetest.New()
	s := durableLeaseService(db, lk, clock)
	creds, err := s.JoinSession(t.Context(), leaseSession(), roomA)
	if err != nil {
		t.Fatal(err)
	}
	p := lk.AddParticipant(roomA, creds.GrantID)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(5 * time.Minute)
	lk.Leave(p)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(6 * time.Minute)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openLeaseDB(t, path, voice.Migrations())
	s = durableLeaseService(db, lk, clock)
	clock.advance(4 * time.Minute)
	lk.Fail(errors.New("list outage after restart"))
	if err := s.Refresh(t.Context()); !errors.Is(err, voice.ErrUnavailable) {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, creds.Token); got != 403 {
		t.Fatalf("reopen/outage reset observed deadline: %d", got)
	}
	lk.AddParticipant(roomA, creds.GrantID)
	lk.Fail(nil)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("unknown restart destroyed actual presence: %d", got)
	}
}

func TestCanceledReservedHandshakeReleasesAdmissionWhileAnotherRequestHoldsStore(t *testing.T) {
	db := openLeaseDB(t, filepath.Join(t.TempDir(), "contention.db"), voice.Migrations())
	clock := &idleClock{now: time.Now()}
	lk := voicetest.New()
	s := durableLeaseService(db, lk, clock)
	gate := &sync.Mutex{}
	s.ConfigureAdmission(gate, func(_ context.Context, session identity.Session) (identity.Session, error) { return session, nil }, "https://falky.example")
	guard, fixture := leaseGuard(t, s, lk)
	creds, err := s.JoinSession(t.Context(), leaseSession(), roomA)
	if err != nil {
		t.Fatal(err)
	}
	entered, releaseUpstream := fixture.block(false)
	defer releaseUpstream()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	dialDone := make(chan struct{})
	go func() {
		defer close(dialDone)
		ws, res, _ := websocket.Dial(ctx, guard.URL+"/rtc?access_token="+url.QueryEscape(creds.Token), nil)
		if ws != nil {
			_ = ws.CloseNow()
		}
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
	}()
	<-entered
	// Exhaust the real SQLite pool after reservation. A signed webhook then
	// owns storeMu while waiting for its uncanceled request's read connection.
	db.Read().SetMaxOpenConns(1)
	held, err := db.Read().Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	releaseStore := sync.OnceFunc(func() { _ = held.Close() })
	defer releaseStore()
	waits := db.Read().Stats().WaitCount
	webhookDone := make(chan error, 1)
	go func() {
		webhookDone <- s.ReceiveWebhook(signed(t, voicetest.Joined(voice.Participant{Room: roomA, Identity: creds.GrantID, SID: "older"}), testKey, testSecret))
	}()
	deadline := time.Now().Add(time.Second)
	for db.Read().Stats().WaitCount == waits {
		if time.Now().After(deadline) {
			t.Fatal("unrelated webhook never held store awaiting SQLite")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-dialDone
	free := make(chan struct{})
	go func() { gate.Lock(); defer gate.Unlock(); close(free) }()
	select {
	case <-free:
	case <-time.After(time.Second):
		releaseStore()
		releaseUpstream()
		t.Fatal("canceled reserved handshake retained admission while unrelated request held store")
	}
	select {
	case err := <-webhookDone:
		t.Fatalf("unrelated request escaped held SQLite before admission release: %v", err)
	default:
	}
	releaseStore()
	if err := <-webhookDone; err != nil {
		t.Fatal(err)
	}
	releaseUpstream()
	clock.advance(10 * time.Minute)
	if got := leaseStatus(t, s, creds.Token); got != 403 {
		t.Fatalf("canceled reservation renewed idle lease: %d", got)
	}
}

func TestMalformedDownstreamHandshakeCannotAdmitUpstreamOrRenewIdleLease(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*http.Request)
		status int
	}{
		{"missing connection", func(r *http.Request) { r.Header.Del("Connection") }, http.StatusUpgradeRequired},
		{"wrong connection", func(r *http.Request) { r.Header.Set("Connection", "keep-alive") }, http.StatusUpgradeRequired},
		{"old HTTP version", func(r *http.Request) { r.Proto = "HTTP/1.0"; r.ProtoMajor = 1; r.ProtoMinor = 0 }, http.StatusUpgradeRequired},
		{"missing version", func(r *http.Request) { r.Header.Del("Sec-WebSocket-Version") }, http.StatusBadRequest},
		{"wrong version", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Version", "12") }, http.StatusBadRequest},
		{"missing key", func(r *http.Request) { r.Header.Del("Sec-WebSocket-Key") }, http.StatusBadRequest},
		{"empty key", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", "") }, http.StatusBadRequest},
		{"duplicate key", func(r *http.Request) { r.Header.Add("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==") }, http.StatusBadRequest},
		{"invalid base64 key", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", "not-base64") }, http.StatusBadRequest},
		{"wrong key length", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQAA") }, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := openLeaseDB(t, filepath.Join(t.TempDir(), "malformed.db"), voice.Migrations())
			clock := &idleClock{now: time.Now()}
			lk := voicetest.New()
			s := durableLeaseService(db, lk, clock)
			fixture := &signalFixture{lk: lk}
			upstream := httptest.NewServer(fixture)
			defer upstream.Close()
			creds, err := s.JoinSession(t.Context(), leaseSession(), roomA)
			if err != nil {
				t.Fatal(err)
			}
			clock.advance(9 * time.Minute)
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/rtc?access_token="+url.QueryEscape(creds.Token), nil)
			request.Header.Set("Connection", "keep-alive, Upgrade")
			request.Header.Set("Upgrade", "websocket")
			request.Header.Set("Sec-WebSocket-Version", "13")
			request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
			test.change(request)
			response := httptest.NewRecorder()
			s.Signalling(upstream.URL).ServeHTTP(response, request)
			if response.Code != test.status {
				t.Errorf("malformed handshake status=%d want=%d", response.Code, test.status)
			}
			participants, err := lk.Participants(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if len(participants) != 0 {
				t.Errorf("malformed downstream handshake reached upstream admission: %v", participants)
			}
			clock.advance(time.Minute)
			if got := leaseStatus(t, s, creds.Token); got != http.StatusForbidden {
				t.Errorf("malformed handshake renewed original deadline: %d", got)
			}
		})
	}
}
