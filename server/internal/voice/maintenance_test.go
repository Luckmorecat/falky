package voice_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/scheduler"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

const maintenanceOrigin = "https://falky.example"

type maintenanceVoice struct {
	db       *platform.DB
	ident    *identity.Service
	voice    *voice.Service
	gate     *httpapi.Lifecycle
	session  identity.Session
	creds    voice.Credentials
	room     string
	handlers httpapi.Handlers
}

func newMaintenanceVoice(t *testing.T) maintenanceVoice {
	t.Helper()
	logger := platform.NewLogger(io.Discard, 0)
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "maintenance.db"), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	migrations, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations(), voice.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), migrations); err != nil {
		t.Fatal(err)
	}
	ident := identity.New(db, maintenanceOrigin)
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatal(err)
	}
	link, err := ident.Link(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_, cookie, err := ident.Enter(t.Context(), strings.TrimPrefix(link, maintenanceOrigin+"/#k="), "Guest")
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
	voices := voice.New(voicetest.New(), ident, rs, voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8}, voice.WithDB(db))
	gate := &httpapi.Lifecycle{}
	handlers := httpapi.New(httpapi.Deps{Identity: ident, Rooms: rs, Voice: voices, Lifecycle: gate, PublicOrigin: maintenanceOrigin, Logger: logger, Metrics: platform.NewMetrics().Handler()})
	creds, err := voices.JoinSession(t.Context(), session, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	return maintenanceVoice{db: db, ident: ident, voice: voices, gate: gate, session: session, creds: creds, room: room.ID, handlers: handlers}
}

func (f maintenanceVoice) joinedWebhook(t *testing.T, handler http.Handler) <-chan error {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	event := voicetest.Joined(voice.Participant{Room: f.room, Identity: f.creds.GrantID, SID: "PA_webhook"})
	body, signature, err := voicetest.Sign(event, testKey, testSecret)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+"/livekit/webhook", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", signature)
	req.Header.Set("Content-Type", "application/webhook+json")
	done := make(chan error, 1)
	go func() {
		defer close(done)
		response, err := server.Client().Do(req)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				err = fmt.Errorf("joined webhook = %d", response.StatusCode)
			}
		}
		done <- err
	}()
	return done
}

func (f maintenanceVoice) requireValidGrant(t *testing.T) {
	t.Helper()
	if _, err := f.ident.ValidateSession(t.Context(), f.session); err != nil {
		t.Fatal("maintenance changed valid session:", err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer upstream.Close()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/rtc/validate?access_token="+f.creds.Token, nil)
	result := httptest.NewRecorder()
	f.voice.Signalling(upstream.URL).ServeHTTP(result, request)
	if result.Code != http.StatusOK {
		t.Fatalf("exact valid grant after cancellation = %d", result.Code)
	}
}

func (f maintenanceVoice) cancelScheduledMaintenance(t *testing.T, releaseWebhook func(), webhookDone <-chan error) {
	t.Helper()
	runCtx, stop := context.WithCancel(t.Context())
	started, joined := make(chan struct{}), make(chan struct{})
	maintained := make(chan error, 1)
	go func() {
		defer close(joined)
		scheduler.Run(runCtx, scheduler.Job{Interval: time.Hour, Startup: true, Run: func(ctx context.Context) {
			close(started)
			maintained <- f.gate.Maintain(ctx, nil, f.voice)
		}})
	}()
	defer func() {
		stop()
		releaseWebhook()
		<-joined
		for err := range webhookDone {
			if err != nil {
				t.Error(err)
			}
		}
	}()
	<-started
	// Leave the live webhook blocked while maintenance reaches its shared gate.
	select {
	case err := <-maintained:
		t.Fatalf("maintenance escaped blocked webhook before cancellation: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	stop()
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("scheduler cancellation still waits for the voice webhook")
	}
	if err := <-maintained; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled maintenance = %v", err)
	}
	select {
	case err := <-webhookDone:
		t.Fatalf("webhook did not remain blocked until scheduler joined: %v", err)
	default:
	}
	releaseWebhook()
}

func TestShutdownJoinsMaintenanceBeforeJoinedWebhookReleasesSQLite(t *testing.T) {
	f := newMaintenanceVoice(t)
	f.db.Read().SetMaxOpenConns(1)
	held, err := f.db.Read().Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(func() { _ = held.Close() })
	defer release()
	waits := f.db.Read().Stats().WaitCount
	done := f.joinedWebhook(t, f.handlers.Internal)
	deadline := time.Now().Add(time.Second)
	for f.db.Read().Stats().WaitCount == waits {
		if time.Now().After(deadline) {
			t.Fatal("signed joined webhook never waited for the exhausted SQLite pool")
		}
		time.Sleep(time.Millisecond)
	}
	f.cancelScheduledMaintenance(t, release, done)
	f.requireValidGrant(t)
}

type webhookValidationKey struct{}

func TestShutdownJoinsMaintenanceBeforeJoinedWebhookFinishesValidation(t *testing.T) {
	f := newMaintenanceVoice(t)
	validating, resume := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(resume) })
	defer release()
	f.voice.ConfigureAdmission(f.gate, func(ctx context.Context, session identity.Session) (identity.Session, error) {
		if ctx.Value(webhookValidationKey{}) != nil {
			close(validating)
			<-resume
		}
		return f.ident.ValidateSession(ctx, session)
	}, maintenanceOrigin)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.handlers.Internal.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), webhookValidationKey{}, true)))
	})
	done := f.joinedWebhook(t, handler)
	select {
	case <-validating:
	case <-time.After(time.Second):
		t.Fatal("joined webhook never reached authoritative validation")
	}
	f.cancelScheduledMaintenance(t, release, done)
	f.requireValidGrant(t)
}

func TestCancelledVoiceOperationsPreserveExactGrantAndReusableGates(t *testing.T) {
	f := newMaintenanceVoice(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	operations := []struct {
		name string
		run  func(context.Context) error
	}{
		{"validate", f.voice.ValidateGrants},
		{"cleanup", f.voice.CleanupGrants},
		{"refresh", f.voice.Refresh},
		{"remove all", f.voice.RemoveAll},
		{"leave", func(ctx context.Context) error { return f.voice.Leave(ctx, f.session, f.creds.GrantID) }},
		{"join", func(ctx context.Context) error {
			_, err := f.voice.JoinSession(ctx, f.session, f.room)
			return err
		}},
	}
	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			if err := operation.run(ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled voice operation = %v", err)
			}
		})
	}
	f.requireValidGrant(t)
	if err := f.voice.Refresh(t.Context()); err != nil {
		t.Fatal("cancelled operation retained publishing gate:", err)
	}
}

func TestShutdownJoinsMaintenanceBeforeGrantFenceObtainsSQLiteWriter(t *testing.T) {
	f := newMaintenanceVoice(t)
	if _, err := f.ident.Rotate(t.Context()); err != nil {
		t.Fatal(err)
	}
	entered, resume := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(resume) })
	writerDone := make(chan error, 1)
	go func() {
		writerDone <- f.db.Write(t.Context(), func(*sql.Tx) error { close(entered); <-resume; return nil })
	}()
	<-entered
	validated := make(chan struct{})
	f.voice.ConfigureAdmission(f.gate, func(ctx context.Context, session identity.Session) (identity.Session, error) {
		current, err := f.ident.ValidateSession(ctx, session)
		close(validated)
		return current, err
	}, maintenanceOrigin)
	runCtx, stop := context.WithCancel(t.Context())
	joined := make(chan struct{})
	maintained := make(chan error, 1)
	go func() {
		defer close(joined)
		scheduler.Run(runCtx, scheduler.Job{Interval: time.Hour, Startup: true, Run: func(ctx context.Context) { maintained <- f.gate.Maintain(ctx, nil, f.voice) }})
	}()
	defer func() {
		stop()
		release()
		<-joined
		if err := <-writerDone; err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-validated:
	case <-time.After(time.Second):
		t.Fatal("maintenance never validated the revoked session")
	}
	select {
	case err := <-maintained:
		t.Fatalf("maintenance escaped held SQLite writer before cancellation: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	stop()
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("scheduler cancellation still waits for the grant fence's SQLite writer")
	}
	if err := <-maintained; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled grant fence = %v", err)
	}
	select {
	case err := <-writerDone:
		t.Fatalf("writer did not remain held until scheduler joined: %v", err)
	default:
	}
	release()
	f.voice.ConfigureAdmission(f.gate, f.ident.ValidateSession, maintenanceOrigin)
	if err := f.gate.Maintain(t.Context(), nil, f.voice); err != nil {
		t.Fatal("cancelled fence retained a voice gate:", err)
	}
}
