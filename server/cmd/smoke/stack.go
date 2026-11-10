package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/kisshot/falky/server/internal/api"
)

// cookieName is the session cookie the server sets on registering or signing
// in, and accessCookie the pass it sets for the access password.
const (
	cookieName   = "falky_visitor"
	accessCookie = "falky_access"
)

// stack is the running Compose stack: its operator commands, and its public
// origin, reached through Caddy.
type stack struct {
	compose    string
	origin     string
	httpClient *http.Client
}

// connect reads the stack's public origin from its Compose configuration and
// makes this process trust Caddy's local authority, copied to caPath.
func connect(ctx context.Context, compose, caPath string) (*stack, error) {
	st := &stack{compose: compose, httpClient: &http.Client{Timeout: 10 * time.Second}}
	config, err := st.docker(ctx, "config", "--format", "json")
	if err != nil {
		return nil, err
	}
	var c struct {
		Services map[string]struct {
			Environment map[string]string `json:"environment"`
		} `json:"services"`
	}
	if err := json.Unmarshal([]byte(config), &c); err != nil {
		return nil, fmt.Errorf("compose config: %w", err)
	}
	st.origin = c.Services["falky"].Environment["FALKY_PUBLIC_ORIGIN"]
	if st.origin == "" {
		return nil, errors.New("compose config: the falky service has no FALKY_PUBLIC_ORIGIN")
	}
	if _, err := st.docker(ctx, "cp", "caddy:/data/caddy/pki/authorities/local/root.crt", caPath); err != nil {
		return nil, fmt.Errorf("copy Caddy's local authority (the stack must serve a local domain): %w", err)
	}
	// Go reads SSL_CERT_FILE when it first verifies a certificate, which
	// nothing in this process has done yet. It is the one setting that
	// reaches every client here, LiveKit's signalling included.
	if err := os.Setenv("SSL_CERT_FILE", caPath); err != nil {
		return nil, err
	}
	return st, nil
}

// docker runs docker compose with args against the stack and returns its
// output.
func (st *stack) docker(ctx context.Context, args ...string) (string, error) {
	return st.dockerWithInput(ctx, "", args...)
}

// dockerWithInput is docker that writes input to the command's stdin.
func (st *stack) dockerWithInput(ctx context.Context, input string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", append([]string{"compose", "-f", st.compose}, args...)...)
	cmd.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("docker compose %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

// falky runs an operator command in the server's container and returns what
// it prints.
func (st *stack) falky(ctx context.Context, args ...string) (string, error) {
	return st.docker(ctx, append([]string{"exec", "-T", "falky", "/falky"}, args...)...)
}

// client returns an API client for the stack that sends cookie, if any, as a
// browser on the stack's origin would.
func (st *stack) client(cookie *http.Cookie) (*api.ClientWithResponses, error) {
	return api.NewClientWithResponses(st.origin, api.WithHTTPClient(st.httpClient),
		api.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
			req.Header.Set("Origin", st.origin)
			if cookie != nil {
				req.AddCookie(cookie)
			}
			return nil
		}))
}

// visitor is someone who registered, with their login and the session cookie
// the server gave them.
type visitor struct {
	api.Visitor
	login  string
	cookie *http.Cookie
	api    *api.ClientWithResponses
}

// errorCode returns the code of an error body, or the body itself when it is
// not one.
func errorCode(body []byte) string {
	var e api.Error
	if json.Unmarshal(body, &e) != nil || e.Code == "" {
		return fmt.Sprintf("%q", body)
	}
	return e.Code
}

// wantError fails unless res answered status, with an error body of code
// unless code is empty.
func wantError(res *http.Response, body []byte, status int, code string) error {
	if res.StatusCode == status && (code == "" || errorCode(body) == code) {
		return nil
	}
	want := fmt.Sprint(status)
	if code != "" {
		want += " " + code
	}
	return fmt.Errorf("%s %s answered %d %s, want %s",
		res.Request.Method, res.Request.URL.Path, res.StatusCode, errorCode(body), want)
}

// statusError is a response other than the one a call wanted.
type statusError struct {
	status int
	code   string
}

func (e *statusError) Error() string { return fmt.Sprintf("answered %d %s", e.status, e.code) }

// wantRefused fails unless err is a *statusError of status and code. It
// closes l, a connection that should not have opened.
func wantRefused(l *liveConn, err error, status int, code string) error {
	var se *statusError
	switch {
	case err == nil:
		l.close()
		return fmt.Errorf("GET /api/live opened, want %d %s", status, code)
	case !errors.As(err, &se) || se.status != status || se.code != code:
		return fmt.Errorf("%w, want %d %s", err, status, code)
	}
	return nil
}

// dialLive opens GET /api/live with origin and the visitor's cookie. A
// refused upgrade returns a *statusError.
func (st *stack) dialLive(ctx context.Context, v *visitor, origin string) (*liveConn, error) {
	header := http.Header{"Origin": {origin}}
	if v != nil {
		// Set by hand: a cookie jar would not send a Secure cookie to a
		// wss:// URL.
		header.Set("Cookie", (&http.Cookie{Name: v.cookie.Name, Value: v.cookie.Value}).String())
	}
	ws, res, err := websocket.Dial(ctx, st.origin+"/api/live", &websocket.DialOptions{HTTPClient: st.httpClient, HTTPHeader: header})
	if err != nil {
		if res == nil {
			return nil, err
		}
		defer func() { _ = res.Body.Close() }()
		var body bytes.Buffer
		_, _ = body.ReadFrom(res.Body)
		return nil, fmt.Errorf("GET /api/live %w", &statusError{res.StatusCode, errorCode(body.Bytes())})
	}
	l := &liveConn{ws: ws, events: make(chan api.Event, 256)}
	go l.read()
	return l, nil
}

// liveConn is an open live-update connection. A goroutine reads it, which also
// answers the server's pings.
type liveConn struct {
	ws     *websocket.Conn
	events chan api.Event
	// err is why the connection ended; set before events is closed.
	err error
}

func (l *liveConn) read() {
	defer close(l.events)
	for {
		typ, data, err := l.ws.Read(context.Background())
		if err != nil {
			l.err = err
			return
		}
		var e api.Event
		if err := json.Unmarshal(data, &e); err != nil || typ != websocket.MessageText {
			l.err = fmt.Errorf("malformed event %q", data)
			return
		}
		l.events <- e
	}
}

// next waits up to d for an event that match accepts, skipping others. A
// d already spent fails, even with a matching event queued.
func (l *liveConn) next(ctx context.Context, d time.Duration, what string, match func(api.Event) bool) (api.Event, error) {
	if d <= 0 {
		return api.Event{}, fmt.Errorf("%s: no time left", what)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case e, ok := <-l.events:
			if !ok {
				return api.Event{}, fmt.Errorf("%s: the connection ended: %w", what, l.err)
			}
			if match(e) {
				return e, nil
			}
		case <-timer.C:
			return api.Event{}, fmt.Errorf("%s: no event within %s", what, d)
		case <-ctx.Done():
			return api.Event{}, ctx.Err()
		}
	}
}

// closed waits up to d for the server to close the connection, discarding
// events, and returns its close status.
func (l *liveConn) closed(ctx context.Context, d time.Duration) (websocket.StatusCode, error) {
	if d <= 0 {
		return 0, errors.New("the connection closing: no time left")
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case _, ok := <-l.events:
			if !ok {
				return websocket.CloseStatus(l.err), nil
			}
		case <-timer.C:
			return 0, fmt.Errorf("the connection did not close within %s", d)
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
}

// drain discards the events that arrive until none has for quiet.
func (l *liveConn) drain(quiet time.Duration) {
	for {
		select {
		case _, ok := <-l.events:
			if !ok {
				return
			}
		case <-time.After(quiet):
			return
		}
	}
}

// close closes the connection as a client leaving does.
func (l *liveConn) close() {
	_ = l.ws.Close(websocket.StatusNormalClosure, "")
	for range l.events { // until the reader has finished
	}
}

// occupancyIs returns a matcher for occupancy.changed of room listing exactly
// the visitors with ids, in any order.
func occupancyIs(room string, ids ...string) func(api.Event) bool {
	return func(e api.Event) bool {
		if e.Type != api.EventTypeOccupancyChanged {
			return false
		}
		c, err := e.Payload.AsOccupancyChange()
		return err == nil && c.RoomId == room && sameVisitors(c.Occupancy, ids)
	}
}

func sameVisitors(occupancy []api.Participant, ids []string) bool {
	got := make([]string, len(occupancy))
	for i, p := range occupancy {
		got[i] = p.VisitorId
	}
	want := slices.Clone(ids)
	slices.Sort(got)
	slices.Sort(want)
	return slices.Equal(got, want)
}

// voiceConn is a connection to LiveKit, as a client makes with the voice
// credentials the server hands out.
type voiceConn struct {
	room *lksdk.Room
	// disconnected is closed when LiveKit ends the connection.
	disconnected chan struct{}
	once         sync.Once
}

func join(creds *api.VoiceCredentials) (*voiceConn, error) {
	p := &voiceConn{disconnected: make(chan struct{})}
	room, err := lksdk.ConnectToRoomWithToken(creds.Url, creds.Token, &lksdk.RoomCallback{
		OnDisconnectedWithReason: func(lksdk.DisconnectionReason) {
			p.once.Do(func() { close(p.disconnected) })
		},
	}, lksdk.WithAutoSubscribe(false), lksdk.WithConnectTimeout(10*time.Second))
	if err != nil {
		return nil, fmt.Errorf("connect to LiveKit: %w", err)
	}
	p.room = room
	return p, nil
}

// leave disconnects as a client leaving does.
func (p *voiceConn) leave() {
	p.room.Disconnect()
}
