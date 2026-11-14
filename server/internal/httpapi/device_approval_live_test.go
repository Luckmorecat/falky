package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
)

func connectSignIn(t *testing.T, p publicServer, browser *http.Client, id string) *websocket.Conn {
	t.Helper()
	ws, res, err := websocket.Dial(t.Context(), p.srv.URL+"/api/accounts/signin-requests/"+id+"/events", &websocket.DialOptions{HTTPClient: browser, HTTPHeader: http.Header{"Origin": {testOrigin}}})
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	return ws
}

func signInEvent(t *testing.T, ws *websocket.Conn) wireSignInRequest {
	t.Helper()
	e := nextEvent(t, ws)
	if e.Type != api.EventType("account.signin.state_changed") && e.Type != api.EventType("account.signin.requested") {
		t.Fatalf("unexpected event %s", e.Type)
	}
	raw, err := json.Marshal(e.Payload)
	if err != nil {
		t.Fatal(err)
	}
	return decodeSignIn[wireSignInRequest](t, raw)
}

func TestDeviceApprovalPrivateSnapshotsAndRevocation(t *testing.T) {
	p := startPublic(t, 100)
	_, issuer := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, issuer, "Account", key)
	_, peer := loginAccountBrowser(t, p, key)
	issuerLive, peerLive := p.connectLive(t, issuer), p.connectLive(t, peer)
	raw, _ := accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 200)
	link := decodeSignIn[wireSignInLink](t, raw)
	_, candidate := p.browserWithHTTP(t)
	raw, _ = accountRequest(t, p, candidate, "POST", "/api/accounts/signin-requests", map[string]any{"token": link.Token}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	pending := signInEvent(t, issuerLive)
	if pending.ID != begin.Request.ID || pending.State != "pending" {
		t.Fatalf("issuer hint = %+v", pending)
	}
	candidateLive := connectSignIn(t, p, candidate, begin.Request.ID)
	if snapshot := signInEvent(t, candidateLive); snapshot.ID != pending.ID || snapshot.Version != pending.Version {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	p.createRoom(t, "Barrier")
	if e := nextEvent(t, peerLive); e.Type != api.EventTypeRoomChanged {
		t.Fatalf("same-account session received private event: %s", e.Type)
	}
	accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links/"+link.Link.ID+"/approve", map[string]any{"code": begin.Code}, testOrigin, 200)
	if state := signInEvent(t, candidateLive); state.State != "approved" || state.Version != 2 {
		t.Fatalf("candidate state = %+v", state)
	}
	// Reconnect snapshots include approval that happened before admission.
	replacement := connectSignIn(t, p, candidate, begin.Request.ID)
	if state := signInEvent(t, replacement); state.State != "approved" || state.Version != 2 {
		t.Fatalf("approval snapshot = %+v", state)
	}
	readClosed(t, candidateLive, websocket.StatusGoingAway)
	accountRequest(t, p, issuer, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	if state := signInEvent(t, replacement); state.State != "cancelled" || state.Version != 3 {
		t.Fatalf("terminal = %+v", state)
	}
	readClosed(t, replacement, realtime.StatusRevoked)
	if strings.Contains(p.logs.String(), link.Token) || strings.Contains(p.logs.String(), begin.Code) {
		t.Fatal("signin secret leaked in logs")
	}
}

func TestDeviceQRApprovalBeforeConnectAndTargetRevocation(t *testing.T) {
	p := startPublic(t, 100)
	_, phone := p.browserWithHTTP(t)
	enrollAccount(t, p, phone, "Account", passkeytest.New(t))
	_, candidate := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, candidate, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/approve", map[string]any{"token": begin.Token}, testOrigin, 200)
	ws := connectSignIn(t, p, candidate, begin.Request.ID)
	if state := signInEvent(t, ws); state.State != "approved" {
		t.Fatalf("snapshot = %+v", state)
	}
	path := "/api/accounts/signin-requests/" + begin.Request.ID
	accountRequest(t, p, candidate, "POST", path+"/finish", map[string]any{}, testOrigin, 200)
	if state := signInEvent(t, ws); state.State != "consumed" {
		t.Fatalf("consumption = %+v", state)
	}
	accountRequest(t, p, phone, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	accountRequest(t, p, candidate, "POST", path+"/finish", map[string]any{}, testOrigin, 200)
	accountRequest(t, p, candidate, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	if state := signInEvent(t, ws); state.State != "cancelled" {
		t.Fatalf("target revocation = %+v", state)
	}
	readClosed(t, ws, realtime.StatusRevoked)
	accountRequest(t, p, candidate, "POST", path+"/finish", map[string]any{}, testOrigin, 403)
}

func assertSignInSocketClosed(t *testing.T, ws *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	_, _, err := ws.Read(ctx)
	if websocket.CloseStatus(err) != realtime.StatusRevoked {
		t.Fatalf("deadline close = %v", err)
	}
}

func TestDeviceMaintenanceClosesCandidateLiveAndVoiceBeforeBlockedMedia(t *testing.T) {
	p := startPublic(t, 100)
	accountAPI, phone := p.browserWithHTTP(t)
	enrollAccount(t, p, phone, "Account", passkeytest.New(t))
	room := p.createRoom(t, "Voice")
	creds := joinedVoice(t, accountAPI, room.ID)
	live := p.connectLive(t, phone)
	_, candidate := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, candidate, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/approve", map[string]any{"token": begin.Token}, testOrigin, 200)
	waiting := connectSignIn(t, p, candidate, begin.Request.ID)
	signInEvent(t, waiting)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer func() { _ = ws.CloseNow() }()
		if ws.Write(r.Context(), websocket.MessageText, []byte(`{"join":{}}`)) != nil {
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
	p.clock.Advance(identity.AccountSessionTTL)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- p.lifecycle.Maintain(ctx, p.events.Hub, voices) }()
	defer func() {
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Errorf("maintenance cancellation=%v", err)
		}
	}()
	select {
	case <-lk.started:
	case <-time.After(time.Second):
		t.Fatal("media cleanup did not start")
	}
	if state := signInEvent(t, waiting); state.State != "cancelled" {
		t.Fatalf("candidate remained authorized: %+v", state)
	}
	readClosed(t, waiting, realtime.StatusRevoked)
	readClosed(t, live, realtime.StatusRevoked)
	readCtx, stop := context.WithTimeout(t.Context(), time.Second)
	defer stop()
	for {
		if _, _, err := signal.Read(readCtx); err != nil {
			if readCtx.Err() != nil {
				t.Fatal("local voice was not fenced before media cleanup", err)
			}
			break
		}
	}
	if !p.lifecycle.TryLock() {
		t.Fatal("external cleanup retained admission gate")
	}
	p.lifecycle.Unlock()
}

func TestDeviceCandidateUpgradeRegisteredBeforeIssuerLogout(t *testing.T) {
	p := startPublic(t, 100)
	_, phone := p.browserWithHTTP(t)
	enrollAccount(t, p, phone, "Account", passkeytest.New(t))
	_, candidate := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, candidate, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/approve", map[string]any{"token": begin.Token}, testOrigin, 200)
	entered, release := make(chan struct{}), make(chan struct{})
	handler := p.srv.Config.Handler
	held := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(delayedLiveUpgrade{ResponseWriter: w, entered: entered, release: release}, r)
	}))
	t.Cleanup(held.Close)
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	result := make(chan *websocket.Conn, 1)
	dialErr := make(chan error, 1)
	go func() {
		ws, res, err := websocket.Dial(t.Context(), held.URL+"/api/accounts/signin-requests/"+begin.Request.ID+"/events", &websocket.DialOptions{HTTPClient: candidate, HTTPHeader: http.Header{"Origin": {testOrigin}}})
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		if err != nil {
			dialErr <- err
			return
		}
		result <- ws
	}()
	select {
	case <-entered:
	case err := <-dialErr:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("candidate upgrade did not register")
	}
	accountRequest(t, p, phone, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	close(release)
	released = true
	var ws *websocket.Conn
	select {
	case ws = <-result:
	case err := <-dialErr:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("upgrade did not finish")
	}
	defer func() { _ = ws.CloseNow() }()
	if state := signInEvent(t, ws); state.State != "cancelled" {
		t.Fatalf("registered upgrade escaped logout: %+v", state)
	}
	readClosed(t, ws, realtime.StatusRevoked)
}

func TestDeviceCandidateAdmissionSecurityAndOriginalDeadline(t *testing.T) {
	p := signInTestServer(t, startPublic(t, 100), nil)
	_, browser := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	_, stranger := p.browserWithHTTP(t)
	for _, test := range []struct {
		browser *http.Client
		origin  string
		status  int
	}{{browser, "https://foreign.example", 403}, {stranger, testOrigin, 403}} {
		ws, res, err := websocket.Dial(t.Context(), p.srv.URL+"/api/accounts/signin-requests/"+begin.Request.ID+"/events", &websocket.DialOptions{HTTPClient: test.browser, HTTPHeader: http.Header{"Origin": {test.origin}}})
		if ws != nil {
			_ = ws.CloseNow()
		}
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		if err == nil || res == nil || res.StatusCode != test.status {
			t.Fatalf("bad admission: %v %v", res, err)
		}
	}
	p.clock.Advance(299 * time.Second)
	ws := connectSignIn(t, p, browser, begin.Request.ID)
	snapshot := signInEvent(t, ws)
	if !snapshot.ExpiresAt.Equal(begin.Request.ExpiresAt) {
		t.Fatal("reconnect extended original deadline")
	}
	assertSignInSocketClosed(t, ws)
}

func TestDeviceCandidateDefaultIPCapAndAttemptBudget(t *testing.T) {
	p := signInTestServer(t, startPublic(t, 100), nil)
	type bound struct {
		id      string
		browser *http.Client
	}
	var candidates []bound
	for range 17 {
		begin, _, err := p.identity.BeginQRSignIn(t.Context(), "", "", "Browser", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, browser := p.browserWithHTTP(t)
		target, _ := url.Parse(p.srv.URL)
		browser.Jar.SetCookies(target, []*http.Cookie{{Name: signInCookie, Value: begin.BrowserSecret, Path: "/", Secure: true}})
		candidates = append(candidates, bound{begin.Request.ID, browser})
	}
	var sockets []*websocket.Conn
	for _, c := range candidates[:16] {
		ws := connectSignIn(t, p, c.browser, c.id)
		signInEvent(t, ws)
		sockets = append(sockets, ws)
	}
	last := candidates[16]
	ws, res, err := websocket.Dial(t.Context(), p.srv.URL+"/api/accounts/signin-requests/"+last.id+"/events", &websocket.DialOptions{HTTPClient: last.browser, HTTPHeader: http.Header{"Origin": {testOrigin}}})
	if ws != nil {
		_ = ws.CloseNow()
	}
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err == nil || res == nil || res.StatusCode != 429 || res.Header.Get("Retry-After") != "1" {
		t.Fatal("default 16/IP limit missing")
	}
	replacement := connectSignIn(t, p, candidates[0].browser, candidates[0].id)
	signInEvent(t, replacement)
	readClosed(t, sockets[0], websocket.StatusGoingAway)
	// Failed bound requests consume the independent handshake budget as well.
	for range 2 {
		accountRequest(t, p, last.browser, "GET", "/api/accounts/signin-requests/missing/events", nil, testOrigin, 400)
	}
	_, res2 := accountRequest(t, p, last.browser, "GET", "/api/accounts/signin-requests/missing/events", nil, testOrigin, 429)
	if res2.Header.Get("Retry-After") != "3" {
		t.Fatal("handshake refill missing")
	}
	beginAccount(t, p, last.browser, "/api/accounts/authentication/begin", map[string]any{})
}

func TestDeviceCandidateSnapshotSurvivesDatabaseReopen(t *testing.T) {
	p := signInTestServer(t, startPublic(t, 100), nil)
	_, phone := p.browserWithHTTP(t)
	enrollAccount(t, p, phone, "Account", passkeytest.New(t))
	_, browser := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/approve", map[string]any{"token": begin.Token}, testOrigin, 200)
	var seq int
	var name, path string
	if err := p.db.Read().QueryRowContext(t.Context(), "PRAGMA database_list").Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	if err := p.events.Hub.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	p.srv.Close()
	if err := p.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := platform.OpenDB(t.Context(), path, p.events.Logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	p.db = db
	p.identity = identity.New(db, testOrigin, identity.WithClock(p.clock.Now))
	p.rooms = rooms.New(db)
	p.voice = nil
	p.lifecycle = &Lifecycle{}
	p.events.Hub = realtime.New()
	t.Cleanup(func() { _ = p.events.Hub.Shutdown(context.Background()) })
	p = signInTestServer(t, p, nil)
	p.clock.Advance(time.Minute)
	ws := connectSignIn(t, p, browser, begin.Request.ID)
	if state := signInEvent(t, ws); state.State != "approved" || state.Version != 2 || !state.ExpiresAt.Equal(begin.Request.ExpiresAt) {
		t.Fatalf("restart snapshot=%+v", state)
	}
	accountRequest(t, p, browser, "POST", "/api/accounts/signin-requests/"+begin.Request.ID+"/finish", map[string]any{}, testOrigin, 200)
	if state := signInEvent(t, ws); state.State != "consumed" || state.Version != 3 {
		t.Fatalf("restart completion=%+v", state)
	}
}
