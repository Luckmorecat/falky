package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/scheduler"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/livekit/protocol/auth"
)

func TestLogoutEndsOnlyItsLiveSession(t *testing.T) {
	p := startPublic(t, 100)
	_, first := p.browserWithHTTP(t)
	enrollAccount(t, p, first, "Account", passkeytest.New(t))
	ws := p.connectLive(t, first)
	// Another browser still receives global room events after the logout.
	b, guest := p.browserWithHTTP(t)
	p.enter(t, b, "Guest")
	other := p.connectLive(t, guest)
	accountRequest(t, p, first, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, http.StatusOK)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	_, _, err := ws.Read(ctx)
	if websocket.CloseStatus(err) != realtime.StatusRevoked {
		t.Fatalf("logged-out live socket remained: %v", err)
	}
	p.createRoom(t, "Still connected")
	if event := nextEvent(t, other); event.Type != "room.changed" {
		t.Fatalf("guest lost live updates: %v", event.Type)
	}
}

type delayedLiveUpgrade struct {
	http.ResponseWriter
	entered chan<- struct{}
	release <-chan struct{}
}

func (w delayedLiveUpgrade) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	close(w.entered)
	<-w.release
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func TestLogoutFencesRegisteredLiveUpgradeBeforeWebsocketHandshakeCompletes(t *testing.T) {
	p := startPublic(t, 100)
	_, browser := p.browserWithHTTP(t)
	enrollAccount(t, p, browser, "Account", passkeytest.New(t))
	entered, release := make(chan struct{}), make(chan struct{})
	handler := p.srv.Config.Handler
	held := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(delayedLiveUpgrade{ResponseWriter: w, entered: entered, release: release}, r)
	}))
	t.Cleanup(held.Close)
	unblocked := false
	defer func() {
		if !unblocked {
			close(release)
		}
	}()
	type dialResult struct {
		ws  *websocket.Conn
		err error
	}
	result := make(chan dialResult, 1)
	go func() {
		ws, res, err := websocket.Dial(t.Context(), held.URL+"/api/live", &websocket.DialOptions{HTTPClient: browser, HTTPHeader: http.Header{"Origin": {testOrigin}}})
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		result <- dialResult{ws: ws, err: err}
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("live upgrade did not reach pending handshake")
	}
	accountRequest(t, p, browser, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	close(release)
	unblocked = true
	dialed := <-result
	if dialed.err != nil {
		t.Fatal(dialed.err)
	}
	defer func() { _ = dialed.ws.CloseNow() }()
	readClosed(t, dialed.ws, realtime.StatusRevoked)
}

func TestExpiredLiveSessionCannotReceiveGlobalEvents(t *testing.T) {
	p := startPublic(t, 100)
	_, browser := p.browserWithHTTP(t)
	enrollAccount(t, p, browser, "Account", passkeytest.New(t))
	ws := p.connectLive(t, browser)
	p.clock.Advance(identity.AccountSessionTTL)
	p.createRoom(t, "Global event")
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	_, data, err := ws.Read(ctx)
	if websocket.CloseStatus(err) != realtime.StatusRevoked {
		t.Fatalf("expired session received %s, %v", data, err)
	}
}

func loginAccountBrowser(t *testing.T, p publicServer, key *passkeytest.Authenticator) (*api.ClientWithResponses, *http.Client) {
	t.Helper()
	client, browser := p.browserWithHTTP(t)
	ceremony := beginAccount(t, p, browser, "/api/accounts/authentication/begin", map[string]any{})
	var options protocol.CredentialAssertion
	if err := json.Unmarshal(ceremony.Options, &options); err != nil {
		t.Fatal(err)
	}
	accountRequest(t, p, browser, "POST", "/api/accounts/authentication/finish", map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(key.Assertion(t, &options, testOrigin))}, testOrigin, 200)
	return client, browser
}

func readClosed(t *testing.T, ws *websocket.Conn, want websocket.StatusCode) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != want {
				t.Fatalf("close = %v, want %v", err, want)
			}
			return
		}
		if want != realtime.StatusRevoked && strings.Contains(string(data), "access.revoked") {
			t.Fatal("name refresh revoked access")
		}
	}
}

func TestGuestRotationPreservesAccountLiveAndVoice(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	a, accountHTTP := p.browserWithHTTP(t)
	account := enrollAccount(t, p, accountHTTP, "Account", passkeytest.New(t))
	b, guestHTTP := p.browserWithHTTP(t)
	p.enter(t, b, "Guest")
	accountLive, guestLive := p.connectLive(t, accountHTTP), p.connectLive(t, guestHTTP)
	var accountParticipants []voice.Participant
	for range 2 {
		creds := joinedVoice(t, a, room.ID)
		accountParticipants = append(accountParticipants, p.livekit.AddParticipant(room.ID, creds.GrantId))
	}
	for range 2 {
		creds := joinedVoice(t, b, room.ID)
		p.livekit.AddParticipant(room.ID, creds.GrantId)
	}
	if _, err := p.adminClient(t).RotateLink(t.Context()); err != nil {
		t.Fatal(err)
	}
	readClosed(t, guestLive, realtime.StatusRevoked)
	listed, err := p.livekit.Participants(t.Context())
	if err != nil || !slices.Equal(listed, accountParticipants) {
		t.Fatalf("rotation removed account voice: %v %v", listed, err)
	}
	accountRequest(t, p, accountHTTP, "GET", "/api/me", nil, "", 200)
	p.createRoom(t, "Still available")
	for event := nextEvent(t, accountLive); event.Type != api.EventTypeRoomChanged; event = nextEvent(t, accountLive) {
	}
	if got := p.voice.Occupancy(room.ID); len(got) != 2 || got[0].ID != account.Session.Visitor.ID || got[1].ID != account.Session.Visitor.ID {
		t.Fatalf("account occupancy = %v", got)
	}
}

func TestRecoveryAndDisableEndOldLiveSessionsAndPreserveRecoverySession(t *testing.T) {
	p := startPublic(t, 100)
	firstAPI, first := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	account := enrollAccount(t, p, first, "Account", key)
	secondAPI, second := loginAccountBrowser(t, p, key)
	room := p.createRoom(t, "Voice")
	var oldVoice []api.VoiceCredentials
	for _, client := range []*api.ClientWithResponses{firstAPI, secondAPI} {
		for range 2 {
			creds := joinedVoice(t, client, room.ID)
			oldVoice = append(oldVoice, creds)
			p.livekit.AddParticipant(room.ID, creds.GrantId)
		}
	}
	old := []*websocket.Conn{p.connectLive(t, first), p.connectLive(t, second)}
	_, recovering := p.browserWithHTTP(t)
	ceremony := beginAccount(t, p, recovering, "/api/accounts/recovery/begin", map[string]any{"accountId": account.Session.Visitor.ID, "proof": account.RecoveryCodes[0]})
	finishEnrollment(t, p, recovering, ceremony, passkeytest.New(t), "recovery")
	for _, ws := range old {
		readClosed(t, ws, realtime.StatusRevoked)
	}
	p = restartVoice(t, p)
	for _, creds := range oldVoice {
		checkVoiceValidation(t, p, creds.Token, 403)
	}
	var freshVoice []api.VoiceCredentials
	for range 2 {
		raw, _ := accountRequest(t, p, recovering, "POST", "/api/rooms/"+room.ID+"/voice", nil, testOrigin, 200)
		var creds api.VoiceCredentials
		if err := json.Unmarshal(raw, &creds); err != nil {
			t.Fatal(err)
		}
		freshVoice = append(freshVoice, creds)
		p.livekit.AddParticipant(room.ID, creds.GrantId)
	}
	fresh := p.connectLive(t, recovering)
	p.createRoom(t, "Recovered")
	if got := nextEvent(t, fresh); got.Type != api.EventTypeRoomChanged {
		t.Fatalf("recovery session lost live: %v", got.Type)
	}
	if err := p.adminClient(t).DisableAccount(t.Context(), account.Session.Visitor.ID); err != nil {
		t.Fatal(err)
	}
	readClosed(t, fresh, realtime.StatusRevoked)
	for _, creds := range freshVoice {
		checkVoiceValidation(t, p, creds.Token, 403)
	}
}

func TestAccountRenameRefreshesOwnerAndDisplacedGuestWithCurrentVoiceNames(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	a, accountHTTP := p.browserWithHTTP(t)
	account := enrollAccount(t, p, accountHTTP, "Account", passkeytest.New(t))
	b, guestHTTP := p.browserWithHTTP(t)
	guest := p.enter(t, b, "Guest")
	accountLive, guestLive := p.connectLive(t, accountHTTP), p.connectLive(t, guestHTTP)
	credentials := joinedVoice(t, a, room.ID)
	verifier, err := auth.ParseAPIToken(credentials.Token)
	if err != nil {
		t.Fatal(err)
	}
	p.livekit.AddParticipant(room.ID, verifier.Identity())
	p.inVoice(t, b, guest, room.ID)
	renamed, err := a.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: "Guest"})
	if err != nil || renamed.StatusCode() != 200 {
		t.Fatalf("account rename = %v %v", renamed, err)
	}
	readClosed(t, guestLive, websocket.StatusGoingAway)
	readClosed(t, accountLive, websocket.StatusGoingAway)
	me, err := b.GetMeWithResponse(t.Context())
	if err != nil || me.JSON200 == nil || me.JSON200.Name == "Guest" {
		t.Fatalf("displaced guest not renamed: %v %v", me, err)
	}
	if got := p.voice.Occupancy(room.ID); len(got) != 2 {
		t.Fatalf("occupancy = %v", got)
	} else {
		for _, v := range got {
			if v.ID == account.Session.Visitor.ID && v.Name != "Guest" {
				t.Fatal("owner voice name stale")
			}
			if v.ID == guest.Id && v.Name != me.JSON200.Name {
				t.Fatal("displaced voice name stale")
			}
		}
	}
	p.connectLive(t, guestHTTP)
	p.connectLive(t, accountHTTP)
}

func TestLegacyConfirmationValuesAllPreserveIndependentAccountConnections(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	firstAPI, first := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, first, "Account", key)
	_, second := loginAccountBrowser(t, p, key)
	old := joinedVoice(t, firstAPI, room.ID)
	participant := p.livekit.AddParticipant(room.ID, old.GrantId)
	for _, body := range []any{nil, map[string]any{"confirmTransfer": false}, map[string]any{"confirmTransfer": true}} {
		raw, _ := accountRequest(t, p, second, "POST", "/api/rooms/"+room.ID+"/voice", body, testOrigin, 200)
		var creds api.VoiceCredentials
		if err := json.Unmarshal(raw, &creds); err != nil {
			t.Fatal(err)
		}
		if creds.GrantId == old.GrantId {
			t.Fatal("Join reused transport")
		}
		listed, _ := p.livekit.Participants(t.Context())
		if len(listed) != 1 || listed[0] != participant {
			t.Fatal("legacy confirmation displaced independent media")
		}
	}
}

func TestAccountVoiceRequiresExactOriginWhileGuestLegacyJoinNeedsNoOrigin(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	_, account := p.browserWithHTTP(t)
	enrollAccount(t, p, account, "Account", passkeytest.New(t))
	path := "/api/rooms/" + room.ID + "/voice"
	accountRequest(t, p, account, "POST", path, map[string]any{"confirmTransfer": true}, "https://foreign.falky.example", 403)
	accountRequest(t, p, account, "POST", path, nil, "", 403)
	accountRequest(t, p, account, "POST", path, nil, testOrigin, 200)
	guestAPI, guest := p.browserWithHTTP(t)
	p.enter(t, guestAPI, "Guest")
	accountRequest(t, p, guest, "POST", path, nil, "", 200)
}

func TestGuestAbsoluteExpiryRefusesHTTPVoiceAndGlobalLiveUpdates(t *testing.T) {
	p := restartVoice(t, startPublic(t, 100))
	room := p.createRoom(t, "Voice")
	client, browser := p.browserWithHTTP(t)
	p.enter(t, client, "Guest")
	raw, _ := accountRequest(t, p, browser, "GET", "/api/accounts/session", nil, "", http.StatusOK)
	var session api.AccountSession
	if err := json.Unmarshal(raw, &session); err != nil {
		t.Fatal(err)
	}
	if session.Kind != api.AccountSessionKindGuest || session.ExpiresAt == nil || session.ExpiresAt.Unix() != p.clock.Now().Add(identity.GuestSessionTTL).Unix() {
		t.Fatalf("guest expiry missing from session response: %+v", session)
	}
	ws := p.connectLive(t, browser)
	creds := joinedVoice(t, client, room.ID)
	p.clock.Advance(identity.GuestSessionTTL)
	accountRequest(t, p, browser, "GET", "/api/accounts/session", nil, "", http.StatusUnauthorized)
	res, err := client.GetMeWithResponse(t.Context())
	if err != nil || res.StatusCode() != http.StatusUnauthorized {
		t.Fatalf("expired guest API access = %v, %v", res, err)
	}
	checkVoiceValidation(t, p, creds.Token, http.StatusForbidden)
	p.createRoom(t, "Global after expiry")
	readClosed(t, ws, realtime.StatusRevoked)
	p = restartVoice(t, p)
	checkVoiceValidation(t, p, creds.Token, http.StatusForbidden)
}

type heldMaintenanceRemoval struct {
	voice.LiveKit
	started chan struct{}
}

func (lk heldMaintenanceRemoval) RemoveParticipant(ctx context.Context, _, _ string) error {
	close(lk.started)
	<-ctx.Done()
	return ctx.Err()
}

func TestMaintenanceClosesExpiredLocalAccessBeforeBlockedMediaCleanup(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	client, browser := p.browserWithHTTP(t)
	p.enter(t, client, "Guest")
	live := p.connectLive(t, browser)
	creds := joinedVoice(t, client, room.ID)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer func() { _ = ws.CloseNow() }()
		if err := ws.Write(r.Context(), websocket.MessageText, []byte(`{"join":{}}`)); err != nil {
			return
		}
		<-ws.CloseRead(r.Context()).Done()
	}))
	t.Cleanup(upstream.Close)
	lk := heldMaintenanceRemoval{LiveKit: p.livekit, started: make(chan struct{})}
	voices := voice.New(lk, p.identity, p.rooms, voice.Config{APIKey: testLiveKitKey, APISecret: testLiveKitSecret}, voice.WithDB(p.db))
	voices.ConfigureAdmission(p.lifecycle, p.identity.ValidateSession, testOrigin)
	guard := httptest.NewServer(voices.Signalling(upstream.URL))
	t.Cleanup(guard.Close)
	t.Cleanup(voices.CloseSignalling)
	signal, res, err := websocket.Dial(t.Context(), guard.URL+"/rtc?access_token="+url.QueryEscape(creds.Token), nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = signal.CloseNow() }()
	if _, _, err := signal.Read(t.Context()); err != nil {
		t.Fatal(err)
	}
	p.clock.Advance(identity.GuestSessionTTL)
	accountRequest(t, p, browser, "GET", "/api/accounts/session", nil, "", 401)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.lifecycle.Maintain(ctx, p.events.Hub, voices) }()
	defer func() {
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Errorf("cancelled maintenance = %v", err)
		}
	}()
	select {
	case <-lk.started:
	case <-time.After(time.Second):
		t.Fatal("maintenance did not reach media cleanup")
	}
	readClosed(t, live, realtime.StatusRevoked)
	readCtx, stopRead := context.WithTimeout(t.Context(), time.Second)
	defer stopRead()
	for {
		if _, _, err := signal.Read(readCtx); err != nil {
			if readCtx.Err() != nil {
				t.Fatal("expired signaling survived maintenance")
			}
			break
		}
	}
	gateFree := make(chan struct{})
	go func() { p.lifecycle.Lock(); close(gateFree); p.lifecycle.Unlock() }()
	select {
	case <-gateFree:
	case <-time.After(time.Second):
		t.Fatal("media cleanup retained the lifecycle gate")
	}
	healthyAPI, healthyBrowser := p.browserWithHTTP(t)
	p.enter(t, healthyAPI, "Healthy")
	pinged := make(chan struct{}, 1)
	healthy, response, err := websocket.Dial(t.Context(), p.srv.URL+"/api/live", &websocket.DialOptions{
		HTTPClient: healthyBrowser, HTTPHeader: http.Header{"Origin": {testOrigin}},
		OnPingReceived: func(context.Context, []byte) bool { pinged <- struct{}{}; return true },
	})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = healthy.CloseNow() }()
	healthy.CloseRead(t.Context())
	beatCtx, stopBeat := context.WithTimeout(t.Context(), time.Second)
	defer stopBeat()
	if err := healthy.Ping(beatCtx); err != nil {
		t.Fatal(err)
	}
	p.events.Hub.Heartbeat(beatCtx)
	select {
	case <-pinged:
	default:
		t.Fatal("blocked media cleanup delayed a healthy heartbeat")
	}
	select {
	case err := <-done:
		done <- err
		t.Fatalf("media cleanup did not remain blocked: %v", err)
	default:
	}
}

func TestScheduledHeartbeatsContinueWhileMaintenanceWaitsForSQLiteValidation(t *testing.T) {
	p := startPublic(t, 100)
	client, browser := p.browserWithHTTP(t)
	p.enter(t, client, "Guest")
	pings := make(chan struct{}, 32)
	ws, res, err := websocket.Dial(t.Context(), p.srv.URL+"/api/live", &websocket.DialOptions{
		HTTPClient: browser, HTTPHeader: http.Header{"Origin": {testOrigin}},
		OnPingReceived: func(context.Context, []byte) bool { pings <- struct{}{}; return true },
	})
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	ws.CloseRead(t.Context())
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	if err := ws.Ping(ctx); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	p.db.Read().SetMaxOpenConns(1)
	held, err := p.db.Read().Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Close() }()
	waits := p.db.Read().Stats().WaitCount
	runCtx, stop := context.WithCancel(t.Context())
	done, maintained := make(chan struct{}), make(chan error, 1)
	go func() {
		defer close(done)
		scheduler.Run(runCtx,
			scheduler.Job{Interval: 20 * time.Millisecond, Run: p.events.Hub.Heartbeat},
			scheduler.Job{Interval: time.Second, Startup: true, Run: func(ctx context.Context) { maintained <- p.lifecycle.Maintain(ctx, p.events.Hub, p.voice) }},
		)
	}()
	defer func() { stop(); <-done }()
	deadline := time.Now().Add(time.Second)
	for p.db.Read().Stats().WaitCount == waits {
		if time.Now().After(deadline) {
			t.Fatal("maintenance did not block on SQLite session validation")
		}
		time.Sleep(time.Millisecond)
	}
	for range 3 {
		select {
		case <-pings:
		case <-time.After(time.Second):
			t.Fatal("SQLite validation delayed scheduled heartbeats")
		}
	}
	select {
	case err := <-maintained:
		t.Fatalf("maintenance did not stay blocked: %v", err)
	default:
	}
}

func TestCancelledMaintenanceReturnsBeforeTheLifecycleGateIsReleased(t *testing.T) {
	gate := &Lifecycle{}
	gate.Lock()
	defer gate.Unlock()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started, done := make(chan struct{}), make(chan error, 1)
	go func() {
		close(started)
		done <- gate.Maintain(ctx, nil, nil)
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled maintenance = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled maintenance still waits for the lifecycle gate")
	}
}

func TestCancelledMaintenancePreservesValidAccessAndReleasesAnAvailableGate(t *testing.T) {
	p := restartVoice(t, startPublic(t, 100))
	room := p.createRoom(t, "Voice")
	client, browser := p.browserWithHTTP(t)
	p.enter(t, client, "Guest")
	creds := joinedVoice(t, client, room.ID)
	live := p.connectLive(t, browser)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := p.lifecycle.Maintain(ctx, p.events.Hub, p.voice); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled maintenance = %v", err)
	}
	if !p.lifecycle.TryLock() {
		t.Fatal("cancelled maintenance retained the lifecycle gate")
	}
	p.lifecycle.Unlock()
	checkVoiceValidation(t, p, creds.Token, http.StatusOK)
	p.createRoom(t, "Still authorized")
	if event := nextEvent(t, live); event.Type != api.EventTypeRoomChanged {
		t.Fatalf("valid live access changed after cancelled maintenance: %v", event.Type)
	}
}

func TestShutdownJoinsMaintenanceBeforeClosingAdmissionBlockedOnSQLite(t *testing.T) {
	p := startPublic(t, 100)
	client, browser := p.browserWithHTTP(t)
	p.enter(t, client, "Guest")
	gate := &Lifecycle{}
	readingDeadline, resumeValidation := make(chan struct{}), make(chan struct{})
	var deadlineOnce, resumeOnce sync.Once
	resume := func() { resumeOnce.Do(func() { close(resumeValidation) }) }
	defer resume()
	ident := identity.New(p.db, testOrigin, identity.WithClock(func() time.Time {
		if gate.TryLock() {
			gate.Unlock()
		} else {
			// Pause the authoritative deadline check after live admission has
			// acquired the gate, so its subsequent query meets a full DB pool.
			deadlineOnce.Do(func() { close(readingDeadline); <-resumeValidation })
		}
		return p.clock.Now()
	}))
	handlers := New(Deps{
		Identity: ident, Rooms: p.rooms, Live: p.events.Hub, Logger: p.events.Logger,
		Lifecycle: gate, PublicOrigin: testOrigin, Metrics: platform.NewMetrics().Handler(),
	})
	admissionDone := make(chan struct{})
	public := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(admissionDone)
		handlers.Public.ServeHTTP(w, r)
	}))
	t.Cleanup(public.Close)
	dialCtx, stopDial := context.WithCancel(t.Context())
	defer stopDial()
	dialed := make(chan error, 1)
	go func() {
		ws, res, err := websocket.Dial(dialCtx, public.URL+"/api/live", &websocket.DialOptions{HTTPClient: browser, HTTPHeader: http.Header{"Origin": {testOrigin}}})
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		if ws != nil {
			_ = ws.CloseNow()
		}
		dialed <- err
	}()
	select {
	case <-readingDeadline:
	case <-time.After(time.Second):
		t.Fatal("live admission did not acquire the lifecycle gate")
	}
	p.db.Read().SetMaxOpenConns(1)
	held, err := p.db.Read().Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Close() }()
	waits := p.db.Read().Stats().WaitCount
	resume()
	deadline := time.Now().Add(time.Second)
	for p.db.Read().Stats().WaitCount == waits {
		if time.Now().After(deadline) {
			t.Fatal("live admission did not wait for SQLite")
		}
		time.Sleep(time.Millisecond)
	}
	runCtx, stopRun := context.WithCancel(t.Context())
	defer stopRun()
	started, joined := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(joined)
		scheduler.Run(runCtx, scheduler.Job{Interval: time.Hour, Startup: true, Run: func(ctx context.Context) {
			close(started)
			if err := gate.Maintain(ctx, p.events.Hub, nil); !errors.Is(err, context.Canceled) {
				t.Errorf("cancelled maintenance = %v", err)
			}
		}})
	}()
	<-started
	stopRun()
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("scheduler shutdown waited for admission's gate or database")
	}
	select {
	case err := <-dialed:
		t.Fatalf("live admission did not remain blocked during scheduler shutdown: %v", err)
	default:
	}
	shutdownCtx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if err := public.Config.Shutdown(shutdownCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("active admission shutdown = %v", err)
	}
	if err := public.Config.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-dialed:
		if err == nil {
			t.Fatal("blocked admission unexpectedly upgraded during shutdown")
		}
	case <-time.After(time.Second):
		t.Fatal("forced HTTP shutdown did not cancel SQLite-blocked admission")
	}
	select {
	case <-admissionDone:
	case <-time.After(time.Second):
		t.Fatal("SQLite-blocked admission did not finish after HTTP shutdown")
	}
	if !gate.TryLock() {
		t.Fatal("admission retained the lifecycle gate after HTTP shutdown")
	}
	gate.Unlock()
}
