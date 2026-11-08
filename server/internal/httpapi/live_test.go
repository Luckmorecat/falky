package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/api"
)

// connectLive opens GET /api/live as the visitor whose cookies hc holds,
// from the server's own origin.
func (p publicServer) connectLive(t *testing.T, hc *http.Client) *websocket.Conn {
	t.Helper()
	ws, res, err := websocket.Dial(t.Context(), p.srv.URL+"/api/live", &websocket.DialOptions{
		HTTPClient: hc,
		HTTPHeader: http.Header{"Origin": {testOrigin}},
	})
	if err != nil {
		status := 0
		if res != nil {
			status = res.StatusCode
			_ = res.Body.Close()
		}
		t.Fatalf("Dial /api/live: %d %v", status, err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	return ws
}

// upgradeRequest attempts a WebSocket upgrade of GET /api/live with origin
// (none when empty) through hc and returns the response status and body.
func (p publicServer) upgradeRequest(t *testing.T, hc *http.Client, origin string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.srv.URL+"/api/live", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := hc.Do(req)
	if err != nil {
		t.Fatalf("GET /api/live: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusSwitchingProtocols {
		return res.StatusCode, nil // the body is the open connection
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return res.StatusCode, body
}

// nextEvent reads the next event from ws, failing the test unless one comes
// within a second.
func nextEvent(t *testing.T, ws *websocket.Conn) api.Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	typ, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("no event within a second: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("event is a %v message, want text", typ)
	}
	var e api.Event
	if err := json.Unmarshal(data, &e); err != nil {
		t.Fatalf("event %s: %v", data, err)
	}
	if e.V != api.EventVN1 || !e.Type.Valid() || e.Timestamp.IsZero() {
		t.Errorf("event %s: want v 1, a known type and a timestamp", data)
	}
	if _, err := ulid.ParseStrict(e.EventId); err != nil {
		t.Errorf("event %s: eventId is not a ULID: %v", data, err)
	}
	return e
}

func TestLiveUpdatesNeedAVisitor(t *testing.T) {
	p := startPublic(t, 10)
	status, body := p.upgradeRequest(t, p.srv.Client(), testOrigin)
	wantError(t, "GET /api/live without a cookie", status, body, http.StatusUnauthorized, "visitor_required")
}

func TestLiveUpdatesRefuseForeignOrigins(t *testing.T) {
	p := startPublic(t, 10)
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	for _, origin := range []string{"https://evil.example", "http://falky.example", "https://falky.example:8443", "null", ""} {
		status, body := p.upgradeRequest(t, hc, origin)
		wantError(t, "GET /api/live from origin "+origin, status, body, http.StatusForbidden, "origin_forbidden")
	}
	// The same request from the server's own origin upgrades.
	if status, _ := p.upgradeRequest(t, hc, testOrigin); status != http.StatusSwitchingProtocols {
		t.Errorf("GET /api/live from the server's origin = %d, want 101", status)
	}
}

func TestLiveUpdatesNeedAWebSocketUpgrade(t *testing.T) {
	p := startPublic(t, 10)
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.srv.URL+"/api/live", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Origin", testOrigin)
	res, err := hc.Do(req)
	if err != nil {
		t.Fatalf("GET /api/live: %v", err)
	}
	body, err := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	wantError(t, "plain GET /api/live", res.StatusCode, body, http.StatusBadRequest, "invalid_request")
}

func TestNewMessagesReachEveryConnectedVisitorWithinASecond(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	bob, bobHTTP := p.browserWithHTTP(t)
	p.enter(t, bob, "Bob")
	ann, annHTTP := p.browserWithHTTP(t)
	p.enter(t, ann, "Ann")
	connections := map[string]*websocket.Conn{
		"Bob, first tab":  p.connectLive(t, bobHTTP),
		"Bob, second tab": p.connectLive(t, bobHTTP),
		"Ann":             p.connectLive(t, annHTTP),
	}

	m := posted(t, bob, lounge.ID, "k1", "Anyone up for a game?")
	for name, ws := range connections {
		e := nextEvent(t, ws)
		got, err := e.Payload.AsMessage()
		if err != nil {
			t.Fatalf("%s: payload: %v", name, err)
		}
		if e.Type != api.EventTypeMessageCreated || e.RoomId != lounge.ID || !reflect.DeepEqual(got, m) {
			t.Errorf("%s got %s in room %q with %+v, want message.created in %s with %+v", name, e.Type, e.RoomId, got, lounge.ID, m)
		}
	}

	// Repeating the request creates no message and sends no event: the next
	// event is the next new message.
	if res := attemptPost(t, bob, lounge.ID, "k1", "Anyone up for a game?"); res.StatusCode() != http.StatusOK {
		t.Fatalf("repeated request = %d %s, want 200", res.StatusCode(), res.Body)
	}
	next := posted(t, ann, lounge.ID, "k1", "Sure")
	for name, ws := range connections {
		got, err := nextEvent(t, ws).Payload.AsMessage()
		if err != nil || got.Id != next.Id {
			t.Errorf("%s: event after the repeat = %+v, %v; want Ann's message %s", name, got, err, next.Id)
		}
	}
}

func TestRoomChangesReachEveryConnection(t *testing.T) {
	p := startPublic(t, 10)
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	ws := p.connectLive(t, hc)

	lounge := p.createRoom(t, "Lounge")
	if _, err := p.rooms.Rename(t.Context(), lounge.ID, "Living room"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	for _, want := range []api.RoomChange{{Id: lounge.ID, Name: "Lounge"}, {Id: lounge.ID, Name: "Living room"}} {
		e := nextEvent(t, ws)
		got, err := e.Payload.AsRoomChange()
		if err != nil || e.Type != api.EventTypeRoomChanged || e.RoomId != "" || got != want {
			t.Errorf("event = %s room %q %+v, %v; want room.changed with no roomId and %+v", e.Type, e.RoomId, got, err, want)
		}
	}
}
