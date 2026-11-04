package httpapi

import (
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kisshot/falky/server/internal/api"
)

// enterOnceFree enters as name through b, retrying while the name is taken,
// as it is until the server has seen the last connection of its holder end.
// It fails the test unless entering succeeds within five seconds.
func (p publicServer) enterOnceFree(t *testing.T, b *api.ClientWithResponses, name string) api.Visitor {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		res, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: name})
		if err != nil {
			t.Fatalf("Enter: %v", err)
		}
		if res.StatusCode() == http.StatusCreated && res.JSON201 != nil {
			return *res.JSON201
		}
		if res.StatusCode() != http.StatusConflict || time.Now().After(deadline) {
			t.Fatalf("Enter(%q) = %d %s, want 201 once the name is free", name, res.StatusCode(), res.Body)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// me returns the current visitor of b, failing the test unless GET /api/me
// succeeds.
func me(t *testing.T, b *api.ClientWithResponses) api.Visitor {
	t.Helper()
	res, err := b.GetMeWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetMe: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil {
		t.Fatalf("GetMe = %d %s, want 200", res.StatusCode(), res.Body)
	}
	return *res.JSON200
}

// closeLive closes ws with a normal closure and fails the test unless the
// server answers it.
func closeLive(t *testing.T, ws *websocket.Conn) {
	t.Helper()
	if err := ws.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestAConnectedVisitorHoldsTheNameUntilTheirLastConnectionCloses(t *testing.T) {
	p := startPublic(t, 1000)
	bob, bobHTTP := p.browserWithHTTP(t)
	p.enter(t, bob, "Bob")
	tab1 := p.connectLive(t, bobHTTP)
	tab2 := p.connectLive(t, bobHTTP)

	// Connecting took over the reservation from entering, so it does not
	// lapse while Bob stays connected.
	p.clock.Advance(time.Hour)
	res, err := p.browser(t).EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: " bob "})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	wantError(t, "Enter(bob) while Bob is connected", res.StatusCode(), res.Body, http.StatusConflict, "name_taken")
	ann := p.browser(t)
	p.enter(t, ann, "Ann")
	rename, err := ann.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: "BOB"})
	if err != nil {
		t.Fatalf("RenameMe: %v", err)
	}
	wantError(t, "RenameMe(BOB) while Bob is connected", rename.StatusCode(), rename.Body, http.StatusConflict, "name_taken")

	closeLive(t, tab1)
	closeLive(t, tab2)
	p.enterOnceFree(t, p.browser(t), "bob")
}

func TestTheReservationFromEnteringLapsesWithoutAConnection(t *testing.T) {
	p := startPublic(t, 10)
	p.enter(t, p.browser(t), "Bob")
	p.clock.Advance(59 * time.Second)
	res, err := p.browser(t).EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: "bob"})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	wantError(t, "Enter(bob) 59 s after Bob entered", res.StatusCode(), res.Body, http.StatusConflict, "name_taken")
	p.clock.Advance(time.Second)
	p.enter(t, p.browser(t), "bob")
}

func TestAFailedUpgradeLeavesTheReservationFromEntering(t *testing.T) {
	p := startPublic(t, 10)
	bob, bobHTTP := p.browserWithHTTP(t)
	p.enter(t, bob, "Bob")
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.srv.URL+"/api/live", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13") // but no Sec-WebSocket-Key
	res, err := bobHTTP.Do(req)
	if err != nil {
		t.Fatalf("GET /api/live: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("upgrade without a key = %d, want 400", res.StatusCode)
	}

	attempt, err := p.browser(t).EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: "bob"})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	wantError(t, "Enter(bob) after Bob's upgrade failed", attempt.StatusCode(), attempt.Body, http.StatusConflict, "name_taken")
	p.clock.Advance(time.Minute)
	p.enter(t, p.browser(t), "bob")
}

func TestAReturningVisitorWhoseNameIsTakenIsKeptOutOfLiveUpdatesAndVoiceUntilTheyRename(t *testing.T) {
	p := startPublic(t, 1000)
	lounge := p.createRoom(t, "Lounge")
	x, xHTTP := p.browserWithHTTP(t)
	p.enter(t, x, "Bob")
	closeLive(t, p.connectLive(t, xHTTP))
	y, yHTTP := p.browserWithHTTP(t)
	p.enterOnceFree(t, y, "bob")
	p.connectLive(t, yHTTP)

	if got := me(t, x); !got.NameTaken || got.Name != "Bob" {
		t.Errorf("GetMe for X = %+v, want Bob with nameTaken", got)
	}
	if got := me(t, y); got.NameTaken {
		t.Errorf("GetMe for Y = %+v, want nameTaken false", got)
	}
	status, body := p.upgradeRequest(t, xHTTP, testOrigin)
	wantError(t, "GET /api/live for X", status, body, http.StatusConflict, "name_taken")
	join := joinVoice(t, x, lounge.ID)
	wantError(t, "JoinVoice for X", join.StatusCode(), join.Body, http.StatusConflict, "name_taken")

	// Reading rooms and the chat, and posting, stay open to X.
	if res, err := x.ListRoomsWithResponse(t.Context()); err != nil || res.StatusCode() != http.StatusOK {
		t.Errorf("ListRooms for X = %v, %v, want 200", res, err)
	}
	posted(t, x, lounge.ID, "k1", "hello")
	if got := history(t, x, lounge.ID, api.ListMessagesParams{}); len(got) != 1 || got[0].AuthorName != "Bob" {
		t.Errorf("history for X = %+v, want X's message under Bob", got)
	}

	renamed, err := x.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: "Rob"})
	if err != nil {
		t.Fatalf("RenameMe: %v", err)
	}
	if renamed.StatusCode() != http.StatusOK || renamed.JSON200 == nil || renamed.JSON200.NameTaken {
		t.Fatalf("RenameMe(Rob) for X = %d %s, want 200 with nameTaken false", renamed.StatusCode(), renamed.Body)
	}
	if got := me(t, x); got.NameTaken || got.Name != "Rob" {
		t.Errorf("GetMe for X after renaming = %+v, want Rob without nameTaken", got)
	}
	p.connectLive(t, xHTTP)
	joinedVoice(t, x, lounge.ID)
}

func TestAReservationFromEnteringLeavesAReturningVisitorInAndTheReserverIsInConflictOnceTheyConnect(t *testing.T) {
	p := startPublic(t, 1000)
	lounge := p.createRoom(t, "Lounge")
	x, xHTTP := p.browserWithHTTP(t)
	p.enter(t, x, "Bob")
	closeLive(t, p.connectLive(t, xHTTP))
	y, yHTTP := p.browserWithHTTP(t)
	p.enterOnceFree(t, y, "bob") // and never connects

	if got := me(t, x); got.NameTaken {
		t.Errorf("GetMe for X while Y only reserved bob = %+v, want nameTaken false", got)
	}
	p.connectLive(t, xHTTP)
	joinedVoice(t, x, lounge.ID)

	if got := me(t, y); !got.NameTaken {
		t.Errorf("GetMe for Y once X connected = %+v, want nameTaken", got)
	}
	status, body := p.upgradeRequest(t, yHTTP, testOrigin)
	wantError(t, "GET /api/live for Y", status, body, http.StatusConflict, "name_taken")
	join := joinVoice(t, y, lounge.ID)
	wantError(t, "JoinVoice for Y", join.StatusCode(), join.Body, http.StatusConflict, "name_taken")
}
