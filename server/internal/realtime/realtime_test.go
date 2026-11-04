package realtime_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kisshot/falky/server/internal/realtime"
)

// change is one call of the hub's connected func.
type change struct {
	visitorID string
	connected bool
}

// testHub is a hub served over a real WebSocket by an httptest server.
type testHub struct {
	hub     *realtime.Hub
	srv     *httptest.Server
	changes chan change
	// served gets what each Serve call reported, once it returns.
	served chan bool
}

// startHub serves a hub with opts. A connection's visitor is the query
// parameter visitor; it may receive events about every room except those
// named by deny parameters.
func startHub(t *testing.T, opts ...realtime.Option) testHub {
	t.Helper()
	changes := make(chan change, 100)
	served := make(chan bool, 100)
	opts = append(opts, realtime.WithConnectedFunc(func(id string, connected bool) {
		changes <- change{id, connected}
	}))
	hub := realtime.New(opts...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deny := r.URL.Query()["deny"]
		served <- hub.Serve(w, r, realtime.Subscriber{
			VisitorID: r.URL.Query().Get("visitor"),
			MayReceive: func(_ context.Context, roomID string) bool {
				return !slices.Contains(deny, roomID)
			},
		})
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.Shutdown(ctx); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	})
	return testHub{hub: hub, srv: srv, changes: changes, served: served}
}

// dial opens a connection for visitor; the hub has it once dial returns.
// deny names rooms whose events the visitor may not receive.
func (h testHub) dial(t *testing.T, visitor string, deny ...string) *websocket.Conn {
	t.Helper()
	url := h.srv.URL + "?visitor=" + visitor
	for _, room := range deny {
		url += "&deny=" + room
	}
	ws, _, err := websocket.Dial(t.Context(), url, nil) //nolint:bodyclose // Dial closes the body on success
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	ws.SetReadLimit(-1)
	t.Cleanup(func() { _ = ws.CloseNow() })
	return ws
}

// wantChange fails the test unless the connected func is next called with
// want, within the given time.
func (h testHub) wantChange(t *testing.T, want change, within time.Duration) {
	t.Helper()
	select {
	case c := <-h.changes:
		if c != want {
			t.Fatalf("connected func got %+v, want %+v", c, want)
		}
	case <-time.After(within):
		t.Fatalf("connected func not called with %+v within %v", want, within)
	}
}

// wantNoChange fails the test if the connected func is called within the
// given time.
func (h testHub) wantNoChange(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case c := <-h.changes:
		t.Fatalf("connected func got %+v, want no call", c)
	case <-time.After(within):
	}
}

// wantServed fails the test unless the next Serve call to return reports
// want within a second.
func (h testHub) wantServed(t *testing.T, want bool) {
	t.Helper()
	select {
	case got := <-h.served:
		if got != want {
			t.Fatalf("Serve reported opened %v, want %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve did not return within a second")
	}
}

// read reads one message from ws within a second.
func read(t *testing.T, ws *websocket.Conn) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	typ, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("Read got a %v message, want text", typ)
	}
	return string(data)
}

func TestEventsReachEveryConnectionWithinASecond(t *testing.T) {
	h := startHub(t)
	bobTab1 := h.dial(t, "bob")
	bobTab2 := h.dial(t, "bob")
	alice := h.dial(t, "alice")

	h.hub.Publish(realtime.Event{Data: []byte(`{"n":1}`)})
	h.hub.Publish(realtime.Event{RoomID: "lounge", Data: []byte(`{"n":2}`)})
	for name, ws := range map[string]*websocket.Conn{"bob tab 1": bobTab1, "bob tab 2": bobTab2, "alice": alice} {
		if got := []string{read(t, ws), read(t, ws)}; !slices.Equal(got, []string{`{"n":1}`, `{"n":2}`}) {
			t.Errorf("%s got %q, want both events in order", name, got)
		}
	}
}

func TestEventsAboutARoomReachOnlyConnectionsThatMayReceiveThem(t *testing.T) {
	h := startHub(t)
	allowed := h.dial(t, "bob")
	denied := h.dial(t, "alice", "lounge")

	h.hub.Publish(realtime.Event{RoomID: "lounge", Data: []byte("lounge")})
	h.hub.Publish(realtime.Event{RoomID: "games", Data: []byte("games")})
	h.hub.Publish(realtime.Event{Data: []byte("everyone")})
	if got := []string{read(t, allowed), read(t, allowed), read(t, allowed)}; !slices.Equal(got, []string{"lounge", "games", "everyone"}) {
		t.Errorf("allowed visitor got %q, want every event", got)
	}
	if got := []string{read(t, denied), read(t, denied)}; !slices.Equal(got, []string{"games", "everyone"}) {
		t.Errorf("denied visitor got %q, want all but the lounge event", got)
	}
}

func TestMessagesFromTheClientAreIgnored(t *testing.T) {
	h := startHub(t)
	ws := h.dial(t, "bob")
	h.wantChange(t, change{"bob", true}, time.Second)
	if err := ws.Write(t.Context(), websocket.MessageText, []byte(`{"type":"message.created"}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := ws.Write(t.Context(), websocket.MessageBinary, []byte{1, 2, 3}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	h.hub.Publish(realtime.Event{Data: []byte("still here")})
	if got := read(t, ws); got != "still here" {
		t.Errorf("after client messages got %q, want the next event", got)
	}
	h.wantNoChange(t, 50*time.Millisecond)
}

func TestTheHubReportsAVisitorsFirstAndLastConnection(t *testing.T) {
	h := startHub(t)
	tab1 := h.dial(t, "bob")
	h.wantChange(t, change{"bob", true}, time.Second)
	tab2 := h.dial(t, "bob")
	h.wantNoChange(t, 100*time.Millisecond)

	if err := tab1.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("Close: %v", err)
	}
	h.wantNoChange(t, 100*time.Millisecond)
	if err := tab2.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("Close: %v", err)
	}
	h.wantChange(t, change{"bob", false}, time.Second)
	h.wantServed(t, true)
	h.wantServed(t, true)

	h.dial(t, "bob")
	h.wantChange(t, change{"bob", true}, time.Second)
}

func TestAFailedUpgradeOpensNoConnection(t *testing.T) {
	h := startHub(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, h.srv.URL+"?visitor=bob", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13") // but no Sec-WebSocket-Key
	res, err := h.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("upgrade without a key = %d, want 400", res.StatusCode)
	}
	h.wantNoChange(t, 50*time.Millisecond)
	h.wantServed(t, false)
}

func TestAConnectionThatMissesHeartbeatsIsClosed(t *testing.T) {
	const interval, timeout = 50 * time.Millisecond, 50 * time.Millisecond
	h := startHub(t, realtime.WithHeartbeat(interval, timeout))

	// A client that reads answers pings; one that never reads does not.
	alive := h.dial(t, "bob")
	h.wantChange(t, change{"bob", true}, time.Second)
	received := make(chan string, 1)
	go func() {
		_, data, err := alive.Read(context.Background())
		if err != nil {
			received <- "error: " + err.Error()
			return
		}
		received <- string(data)
	}()
	h.dial(t, "alice")
	h.wantChange(t, change{"alice", true}, time.Second)

	h.wantChange(t, change{"alice", false}, 10*(interval+timeout))
	time.Sleep(10 * interval)
	h.hub.Publish(realtime.Event{Data: []byte("bob is still connected")})
	select {
	case got := <-received:
		if got != "bob is still connected" {
			t.Errorf("answering client got %q, want the event", got)
		}
	case <-time.After(time.Second):
		t.Error("answering client got no event")
	}
	h.wantNoChange(t, 10*time.Millisecond)
}

func TestAClientThatFallsBehindIsDisconnectedWhileOthersKeepReceiving(t *testing.T) {
	// No heartbeat during the test: the slow client does not read, so it
	// would not answer pings either.
	h := startHub(t, realtime.WithQueueSize(4), realtime.WithHeartbeat(time.Hour, time.Hour))
	slow := h.dial(t, "slow")
	h.wantChange(t, change{"slow", true}, time.Second)
	fast := h.dial(t, "fast")
	h.wantChange(t, change{"fast", true}, time.Second)

	// The fast client reads every event; the slow one reads none until it is
	// disconnected, so its socket buffers fill, then its queue.
	fastGot := make(chan string)
	go func() {
		for {
			_, data, err := fast.Read(context.Background())
			if err != nil {
				close(fastGot)
				return
			}
			fastGot <- string(data[:strings.IndexByte(string(data), ' ')])
		}
	}()
	padding := strings.Repeat("x", 256<<10)
	dropped := false
	n := 0
	for ; n < 1000 && !dropped; n++ {
		label := fmt.Sprint(n)
		h.hub.Publish(realtime.Event{Data: []byte(label + " " + padding)})
		select {
		case got := <-fastGot:
			if got != label {
				t.Fatalf("fast client got event %s, want %s", got, label)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("fast client did not get event %s", label)
		}
		select {
		case c := <-h.changes:
			if c != (change{"slow", false}) {
				t.Fatalf("connected func got %+v, want slow disconnected", c)
			}
			dropped = true
		default:
		}
	}
	if !dropped {
		t.Fatalf("slow client still connected after %d events", n)
	}

	h.hub.Publish(realtime.Event{Data: []byte("after " + padding)})
	if got := <-fastGot; got != "after" {
		t.Errorf("fast client got %s after the drop, want the next event", got)
	}
	// The slow client finds the events queued before the drop, then the
	// close code; never an event published after it.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	for {
		_, data, err := slow.Read(ctx)
		if err != nil {
			if status := websocket.CloseStatus(err); status != realtime.StatusBehind {
				t.Errorf("slow client read error %v (close status %d), want close status %d", err, status, realtime.StatusBehind)
			}
			break
		}
		if strings.HasPrefix(string(data), "after ") {
			t.Fatal("slow client got an event published after it was disconnected")
		}
	}
}

func TestShutdownClosesConnectionsAndRefusesNewOnes(t *testing.T) {
	h := startHub(t)
	ws := h.dial(t, "bob")
	h.wantChange(t, change{"bob", true}, time.Second)
	// The client reads, as a browser does, so it answers the close.
	closed := make(chan error, 1)
	go func() {
		_, _, err := ws.Read(context.Background())
		closed <- err
	}()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := h.hub.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	h.wantChange(t, change{"bob", false}, time.Second)
	if err := <-closed; websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Errorf("open connection after Shutdown: read error %v, want close status going away", err)
	}

	late := h.dial(t, "alice")
	if _, _, err := late.Read(ctx); websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Errorf("connection after Shutdown: read error %v, want close status going away", err)
	}
	h.wantNoChange(t, 50*time.Millisecond)
}
