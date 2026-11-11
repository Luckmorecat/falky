package realtime_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/realtime"
)

func TestPrivateScopesAndCandidatePresence(t *testing.T) {
	changes := make(chan string, 10)
	hub := realtime.New(realtime.WithConnectedFunc(func(id string, _ bool) { changes <- id }))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		hub.Serve(w, r, realtime.Subscriber{VisitorID: q.Get("visitor"), Session: identity.Session{ID: q.Get("session")}, RequestID: q.Get("request"), CandidateIP: "ip", Ticket: hub.Ticket()})
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	dial := func(query string) *websocket.Conn {
		ws, res, err := websocket.Dial(t.Context(), srv.URL+query, nil)
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ws.CloseNow() })
		return ws
	}
	first := dial("?visitor=account&session=one")
	second := dial("?visitor=account&session=two")
	candidate := dial("?request=request")
	hub.Publish(realtime.Event{Data: []byte("ordinary")})
	hub.Publish(realtime.Event{SessionID: "one", Data: []byte("private issuer")})
	hub.Publish(realtime.Event{RequestID: "request", Data: []byte("candidate")})
	hub.Publish(realtime.Event{Data: []byte("barrier")})
	read := func(ws *websocket.Conn, want string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		_, data, err := ws.Read(ctx)
		if err != nil || string(data) != want {
			t.Fatalf("read = %s %v, want %s", data, err, want)
		}
	}
	read(first, "ordinary")
	read(first, "private issuer")
	read(first, "barrier")
	read(second, "ordinary")
	read(second, "barrier")
	read(candidate, "candidate")
	if len(changes) != 1 || <-changes != "account" {
		t.Fatal("candidate affected identity presence")
	}
}

func TestCandidateCapsReplacementFailureAndSlotRelease(t *testing.T) {
	hub := realtime.New(realtime.WithCandidateCaps(1, 2))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		hub.Serve(w, r, realtime.Subscriber{RequestID: q.Get("request"), CandidateIP: q.Get("ip"), Ticket: hub.Ticket(), Initial: []realtime.Event{{RequestID: q.Get("request"), Data: []byte("snapshot")}}})
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	dial := func(request, ip string, want int) *websocket.Conn {
		t.Helper()
		ws, res, err := websocket.Dial(t.Context(), srv.URL+"?request="+request+"&ip="+ip, nil)
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		if want != 101 {
			if res == nil || res.StatusCode != want || err == nil {
				t.Fatalf("admission = %v %v", res, err)
			}
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ws.CloseNow() })
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		_, data, err := ws.Read(ctx)
		if err != nil || string(data) != "snapshot" {
			t.Fatalf("snapshot = %s %v", data, err)
		}
		return ws
	}
	first := dial("one", "a", 101)
	dial("other", "a", 429)
	second := dial("two", "b", 101)
	dial("three", "c", 429)
	replacement := dial("one", "c", 101)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	_, _, err := first.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Fatal("replacement retained old socket:", err)
	}
	// Releasing an existing socket eventually admits another candidate.
	_ = second.Close(websocket.StatusNormalClosure, "done")
	third := dial("three", "b", 101)
	_ = third.Close(websocket.StatusNormalClosure, "done")
	_ = replacement.Close(websocket.StatusNormalClosure, "done")
	bad, err := http.NewRequestWithContext(t.Context(), "GET", srv.URL+"?request=bad&ip=d", nil)
	if err != nil {
		t.Fatal(err)
	}
	bad.Header.Set("Upgrade", "websocket")
	res, err := srv.Client().Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode == 101 {
		t.Fatal("malformed upgrade succeeded")
	}
	dial("after-failure", "d", 101)
}

func TestHealthyCandidateClosesAtOriginalDeadline(t *testing.T) {
	hub := realtime.New()
	deadline := time.Now().Add(200 * time.Millisecond)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.Serve(w, r, realtime.Subscriber{RequestID: "request", CandidateIP: "ip", Deadline: deadline, Ticket: hub.Ticket()})
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	ws, res, err := websocket.Dial(t.Context(), srv.URL, nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	read := make(chan error, 1)
	go func() { _, _, err := ws.Read(ctx); read <- err }()
	if err := ws.Ping(ctx); err != nil {
		t.Fatal("healthy socket:", err)
	}
	if err := <-read; websocket.CloseStatus(err) != realtime.StatusRevoked {
		t.Fatalf("deadline not enforced: %v", err)
	}
}

func TestInFlightCandidateUpgradeCountsAndCanBeReplacedAtCap(t *testing.T) {
	hub := realtime.New(realtime.WithCandidateCaps(1, 1))
	entered, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		sub := realtime.Subscriber{RequestID: q.Get("request"), CandidateIP: "ip", Ticket: hub.Ticket()}
		if q.Get("hold") == "yes" {
			sub.Registered = func() { close(entered); <-release }
		}
		hub.Serve(w, r, sub)
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { _ = hub.Shutdown(context.Background()) })
	type result struct {
		ws  *websocket.Conn
		err error
	}
	first := make(chan result, 1)
	go func() {
		ws, res, err := websocket.Dial(t.Context(), srv.URL+"?request=one&hold=yes", nil)
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		first <- result{ws, err}
	}()
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("upgrade did not register")
	}
	denied, res, err := websocket.Dial(t.Context(), srv.URL+"?request=other", nil)
	if denied != nil {
		_ = denied.CloseNow()
	}
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err == nil || res == nil || res.StatusCode != 429 {
		t.Fatal("in-flight upgrade did not consume capacity")
	}
	replacement, res, err := websocket.Dial(t.Context(), srv.URL+"?request=one", nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal("replacement at cap:", err)
	}
	defer func() { _ = replacement.CloseNow() }()
	close(release)
	released = true
	old := <-first
	if old.err != nil {
		t.Fatal(old.err)
	}
	defer func() { _ = old.ws.CloseNow() }()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	_, _, err = old.ws.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Fatalf("old pending upgrade escaped replacement: %v", err)
	}
}
