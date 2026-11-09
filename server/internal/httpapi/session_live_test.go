package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/realtime"
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
	guest := p.enter(t, b, "Guest")
	accountLive, guestLive := p.connectLive(t, accountHTTP), p.connectLive(t, guestHTTP)
	accountCreds := joinedVoice(t, a, room.ID)
	verifier, err := auth.ParseAPIToken(accountCreds.Token)
	if err != nil {
		t.Fatal(err)
	}
	_, grants, err := verifier.Verify(testLiveKitSecret)
	if err != nil {
		t.Fatal(err)
	}
	accountParticipant := p.livekit.AddParticipant(room.ID, grants.Identity)
	joinedVoice(t, b, room.ID)
	p.livekit.AddParticipant(room.ID, guest.Id)
	if _, err := p.adminClient(t).RotateLink(t.Context()); err != nil {
		t.Fatal(err)
	}
	readClosed(t, guestLive, realtime.StatusRevoked)
	listed, err := p.livekit.Participants(t.Context())
	if err != nil || len(listed) != 1 || listed[0] != accountParticipant {
		t.Fatalf("rotation removed account voice: %v %v", listed, err)
	}
	accountRequest(t, p, accountHTTP, "GET", "/api/me", nil, "", 200)
	p.createRoom(t, "Still available")
	for event := nextEvent(t, accountLive); event.Type != api.EventTypeRoomChanged; event = nextEvent(t, accountLive) {
	}
	if got := p.voice.Occupancy(room.ID); len(got) != 1 || got[0].ID != account.Session.Visitor.ID {
		t.Fatalf("account occupancy = %v", got)
	}
}

func TestRecoveryAndDisableEndOldLiveSessionsAndPreserveRecoverySession(t *testing.T) {
	p := startPublic(t, 100)
	_, first := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	account := enrollAccount(t, p, first, "Account", key)
	_, second := loginAccountBrowser(t, p, key)
	old := []*websocket.Conn{p.connectLive(t, first), p.connectLive(t, second)}
	_, recovering := p.browserWithHTTP(t)
	ceremony := beginAccount(t, p, recovering, "/api/accounts/recovery/begin", map[string]any{"accountId": account.Session.Visitor.ID, "proof": account.RecoveryCodes[0]})
	finishEnrollment(t, p, recovering, ceremony, passkeytest.New(t), "recovery")
	for _, ws := range old {
		readClosed(t, ws, realtime.StatusRevoked)
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

func TestAccountVoiceTransferRequiresExplicitPublicConfirmation(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	firstAPI, first := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, first, "Account", key)
	_, second := loginAccountBrowser(t, p, key)
	old := joinedVoice(t, firstAPI, room.ID)
	verifier, err := auth.ParseAPIToken(old.Token)
	if err != nil {
		t.Fatal(err)
	}
	participant := p.livekit.AddParticipant(room.ID, verifier.Identity())
	raw, _ := accountRequest(t, p, second, "POST", "/api/rooms/"+room.ID+"/voice", nil, testOrigin, 409)
	if !strings.Contains(string(raw), "voice_transfer_required") {
		t.Fatalf("unconfirmed error = %s", raw)
	}
	listed, _ := p.livekit.Participants(t.Context())
	if len(listed) != 1 || listed[0] != participant {
		t.Fatal("unconfirmed public join displaced owner")
	}
	accountRequest(t, p, second, "POST", "/api/rooms/"+room.ID+"/voice", map[string]any{"confirmTransfer": true}, testOrigin, 200)
	listed, _ = p.livekit.Participants(t.Context())
	if len(listed) != 0 {
		t.Fatal("confirmed public transfer left stale media")
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
