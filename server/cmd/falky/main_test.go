package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/platform"
)

// syncBuffer is a bytes.Buffer safe for the server's goroutines to write to
// while the test reads it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	body, err := io.ReadAll(res.Body)
	if err := errors.Join(err, res.Body.Close()); err != nil {
		t.Fatalf("GET %s: read body: %v", url, err)
	}
	return res.StatusCode, string(body)
}

// newListeners listens on loopback for the public and internal listeners and
// on an admin socket at socketPath.
func newListeners(t *testing.T, socketPath string) listeners {
	t.Helper()
	var lc net.ListenConfig
	tcp := func() net.Listener {
		ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		return ln
	}
	adminLn, err := admin.Listen(t.Context(), socketPath)
	if err != nil {
		t.Fatalf("admin listen: %v", err)
	}
	return listeners{public: tcp(), internal: tcp(), admin: adminLn}
}

func TestServeAnswersOnItsListenersAndStopsCleanly(t *testing.T) {
	ls := newListeners(t, filepath.Join(t.TempDir(), "admin.sock"))
	public, internal := "http://"+ls.public.Addr().String(), "http://"+ls.internal.Addr().String()

	var logs syncBuffer
	logger := platform.NewLogger(&logs, 0)
	cfg := platform.Config{DBPath: filepath.Join(t.TempDir(), "falky.db")}
	db, ms, err := openMigrated(t.Context(), cfg, logger)
	if err != nil {
		t.Fatalf("openMigrated: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serveOn(ctx, logger, cfg, db, ms, ls) }()

	if code, body := get(t, internal+"/health/live"); code != http.StatusOK {
		t.Errorf("internal /health/live = %d %s, want 200", code, body)
	}
	// No LiveKit is configured, so voice is degraded but the server ready.
	if code, body := get(t, internal+"/health/ready"); code != http.StatusOK || !strings.Contains(body, `"database":"ok"`) ||
		!strings.Contains(body, `"livekit":"degraded"`) {
		t.Errorf("internal /health/ready = %d %s, want 200 naming database ok and livekit degraded", code, body)
	}
	if code, body := get(t, internal+"/metrics"); code != http.StatusOK || !strings.Contains(body, "go_goroutines") {
		t.Errorf("internal /metrics = %d, want 200 with Go metrics", code)
	}
	for _, path := range []string{"/health/live", "/health/ready", "/metrics"} {
		if code, _ := get(t, public+path); code != http.StatusNotFound {
			t.Errorf("public %s = %d, want 404", path, code)
		}
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveOn after cancel: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveOn did not return after cancel")
	}

	sc := bufio.NewScanner(strings.NewReader(logs.String()))
	lines := 0
	for sc.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(sc.Bytes(), &entry); err != nil {
			t.Errorf("log line is not JSON: %q", sc.Text())
		}
		lines++
	}
	if lines == 0 || !strings.Contains(logs.String(), `"msg":"stopped"`) {
		t.Errorf("logs = %q, want JSON lines ending with stopped", logs.String())
	}
}

func TestShutdownCancelsScheduledMaintenanceBlockedInLiveKit(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	t.Cleanup(upstream.Close)
	ls := newListeners(t, filepath.Join(t.TempDir(), "admin.sock"))
	cfg := platform.Config{DBPath: filepath.Join(t.TempDir(), "falky.db"), LiveKitAPIURL: upstream.URL, LiveKitAPIKey: "key", LiveKitAPISecret: "secret"}
	stop := startServerWith(t, cfg, io.Discard, ls)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("startup maintenance did not reach LiveKit")
	}
	stopped := make(chan struct{})
	go func() { stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not cancel and join blocked maintenance")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("maintenance left its LiveKit request running")
	}
}

func TestReadinessAndTheHealthCommandFailWhenTheDatabaseIsGone(t *testing.T) {
	ls := newListeners(t, filepath.Join(t.TempDir(), "admin.sock"))
	logger := platform.NewLogger(io.Discard, 0)
	cfg := platform.Config{DBPath: filepath.Join(t.TempDir(), "falky.db")}
	db, ms, err := openMigrated(t.Context(), cfg, logger)
	if err != nil {
		t.Fatalf("openMigrated: %v", err)
	}

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serveOn(ctx, logger, cfg, db, ms, ls) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("serveOn: %v", err)
		}
	})

	// Startup must finish its required colour backfill before simulating an outage.
	get(t, "http://"+ls.internal.Addr().String()+"/health/live")
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if code, body := get(t, "http://"+ls.internal.Addr().String()+"/health/ready"); code != http.StatusServiceUnavailable ||
		!strings.Contains(body, `"database":"unavailable"`) {
		t.Errorf("/health/ready = %d %s, want 503 naming database unavailable", code, body)
	}

	// The health command fails readiness with the report, and still passes
	// liveness.
	getenv := healthEnv(t, ls)
	if code, stdout, stderr := runCommand(t, getenv, "health", "ready"); code != 1 ||
		!strings.Contains(stdout, `"database":"unavailable"`) || !strings.Contains(stderr, "503") {
		t.Errorf("health ready = exit %d, stdout %q, stderr %q; want 1, the report naming database unavailable and the status", code, stdout, stderr)
	}
	if code, stdout, stderr := runCommand(t, getenv, "health", "live"); code != 0 {
		t.Errorf("health live = exit %d, stdout %q, stderr %q; want 0", code, stdout, stderr)
	}
}

func TestServeRefusesToStartWithoutTheLiveKitKeys(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "falky.db")
	code, stdout, _ := runCommand(t, env(map[string]string{platform.EnvDBPath: dbPath}), "serve")
	if code != 1 || !strings.Contains(stdout, platform.EnvLiveKitAPISecret) {
		t.Errorf("serve = exit %d, logs %q, want 1 naming %s", code, stdout, platform.EnvLiveKitAPISecret)
	}
	if _, err := os.Stat(dbPath); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("database file: %v, want none created", err)
	}
}

func TestShutdownInterruptsBlockedMultipartReader(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{platform.EnvDBPath: filepath.Join(dir, "falky.db"), platform.EnvAdminSocket: filepath.Join(dir, "admin.sock")}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatal(err)
	}
	stop, public := startServerOn(t, cfg, io.Discard)
	cookie := enterServer(t, vars, public, "Bob")
	_, room, _ := runCommand(t, env(vars), "room", "create", "Lounge")
	conn, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", strings.TrimPrefix(public, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintf(conn, "POST /api/rooms/%s/attachments HTTP/1.1\r\nHost: localhost\r\nCookie: %s\r\nContent-Type: multipart/form-data; boundary=slow\r\nContent-Length: 1000000\r\nExpect: 100-continue\r\n\r\n", strings.TrimSpace(room), cookie.String())
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != 100 {
		t.Fatalf("body admission=%+v %v", response, err)
	}
	_ = response.Body.Close()
	_, err = io.WriteString(conn, "--slow\r\nContent-Disposition: form-data; name=\"file\"; filename=\"slow.txt\"\r\n\r\npartial")
	if err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{})
	go func() { stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown left a blocked request reader")
	}
}

func TestMigrateCommandIsIdempotentAndWarnsWithoutAnAccessPassword(t *testing.T) {
	getenv := env(map[string]string{platform.EnvDBPath: filepath.Join(t.TempDir(), "falky.db")})
	for i := range 2 {
		var stdout, stderr bytes.Buffer
		if code := run(t.Context(), []string{"migrate"}, getenv, nil, &stdout, &stderr); code != 0 {
			t.Fatalf("migrate run %d: exit %d, stdout %q, stderr %q", i+1, code, stdout.String(), stderr.String())
		}
		if !strings.Contains(stdout.String(), "falky password set") {
			t.Errorf("migrate run %d: logs %q, want a warning naming falky password set", i+1, stdout.String())
		}
	}
}

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

// startServer serves the database at cfg.DBPath, with its admin socket at
// cfg.AdminSocket, logging to logs, until the returned stop is called.
func startServer(t *testing.T, cfg platform.Config, logs io.Writer) (stop func()) {
	t.Helper()
	stop, _ = startServerOn(t, cfg, logs)
	return stop
}

// startServerOn is startServer that also returns the public listener's URL.
func startServerOn(t *testing.T, cfg platform.Config, logs io.Writer) (stop func(), publicURL string) {
	t.Helper()
	ls := newListeners(t, cfg.AdminSocket)
	return startServerWith(t, cfg, logs, ls), "http://" + ls.public.Addr().String()
}

// startServerWith is startServer on the listeners ls.
func startServerWith(t *testing.T, cfg platform.Config, logs io.Writer, ls listeners) (stop func()) {
	t.Helper()
	logger := platform.NewLogger(logs, 0)
	db, ms, err := openMigrated(t.Context(), cfg, logger)
	if err != nil {
		t.Fatalf("openMigrated: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serveOn(ctx, logger, cfg, db, ms, ls) }()
	stopped := false
	stop = func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		if err := errors.Join(<-done, db.Close()); err != nil {
			t.Errorf("server: %v", err)
		}
	}
	t.Cleanup(stop)
	return stop
}

// runCommandWithInput is runCommand with stdin.
func runCommandWithInput(t *testing.T, getenv func(string) string, stdin string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code = run(t.Context(), args, getenv, strings.NewReader(stdin), &out, &errOut)
	return code, out.String(), errOut.String()
}

const testAccessPassword = "shared secret phrase"

var registered atomic.Uint32

// enterServer sets the access password through falky password set, gives it
// over HTTP at public and registers name, and returns the session cookie.
func enterServer(t *testing.T, vars map[string]string, public, name string) *http.Cookie {
	t.Helper()
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatal(err)
	}
	if code, out, errOut := runCommandWithInput(t, env(vars), testAccessPassword+"\n", "password", "set"); code != 0 {
		t.Fatalf("password set = exit %d, %q, %q", code, out, errOut)
	}
	post := func(path string, cookie *http.Cookie, body string) []*http.Cookie {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, public+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.PublicOrigin)
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("10.0.0.%d", registered.Add(1)))
		if cookie != nil {
			req.AddCookie(cookie)
		}
		client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("POST %s = %d, want 200", path, res.StatusCode)
		}
		return res.Cookies()
	}
	var access *http.Cookie
	for _, c := range post("/api/access", nil, `{"password":"`+testAccessPassword+`"}`) {
		if c.Name == "falky_access" {
			access = c
		}
	}
	login := strings.ToLower(strings.ReplaceAll(name, " ", "-"))
	for len(login) < 3 {
		login += "x"
	}
	for _, c := range post("/api/accounts/register", access, `{"login":"`+login+`","password":"correct horse battery","name":"`+name+`"}`) {
		if c.Name == "falky_visitor" {
			return c
		}
	}
	t.Fatal("registering set no session cookie")
	return nil
}

func TestPasswordSetReadsStdinAndNeedsARunningServer(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:      filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket: filepath.Join(dir, "admin.sock"),
	}
	if code, out, stderr := runCommandWithInput(t, env(vars), testAccessPassword+"\n", "password", "set"); code == 0 || out != "" || !strings.Contains(stderr, "not running") {
		t.Errorf("password set without a server = exit %d, %q, %q; want it to say the server is not running", code, out, stderr)
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatal(err)
	}
	var logs syncBuffer
	startServer(t, cfg, &logs)
	for input, want := range map[string]string{"": "no password", "short\n": "8 to 128"} {
		if code, _, stderr := runCommandWithInput(t, env(vars), input, "password", "set"); code == 0 || !strings.Contains(stderr, want) {
			t.Errorf("password set with %q = exit %d, %q; want an error saying %q", input, code, stderr, want)
		}
	}
	code, out, stderr := runCommandWithInput(t, env(vars), testAccessPassword+"\r\n", "password", "set")
	if code != 0 || !strings.Contains(out, "access password set") {
		t.Fatalf("password set = exit %d, %q, %q", code, out, stderr)
	}
	if strings.Contains(logs.String(), testAccessPassword) || strings.Contains(out, testAccessPassword) {
		t.Error("the access password appears in the output or logs")
	}
}

func TestRunRefusesUnknownCommands(t *testing.T) {
	for _, args := range [][]string{
		nil,
		{"frobnicate"},
		{"serve", "extra"},
		{"link", "show"},
		{"password"},
		{"password", "set", "extra"},
		{"account"},
		{"account", "disable"},
		{"invitation", "create"},
		{"room"},
		{"room", "create"},
		{"room", "create", "Living", "room"},
		{"room", "rename", "01JBX6Z8Q3M5W2K7R9T4V1C0DE"},
		{"room", "rename", "01JBX6Z8Q3M5W2K7R9T4V1C0DE", "Living", "room"},
		{"room", "delete", "x"},
		{"health"},
		{"health", "metrics"},
		{"health", "ready", "extra"},
		{"snapshot", "extra"},
		{"restore", "falky.db"},
	} {
		var stdout, stderr bytes.Buffer
		if code := run(t.Context(), args, func(string) string { return "" }, nil, &stdout, &stderr); code != 2 {
			t.Errorf("run %q = %d, want 2", args, code)
		}
		if !strings.Contains(stderr.String(), "usage:") {
			t.Errorf("run %q stderr = %q, want usage", args, stderr.String())
		}
	}
}

func TestMessagesRoomsAndVisitorsSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:      filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket: filepath.Join(dir, "admin.sock"),
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	stop, public := startServerOn(t, cfg, io.Discard)
	_, out, _ := runCommand(t, env(vars), "room", "create", "Lounge")
	roomID := strings.TrimSpace(out)

	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	cookie := enterServer(t, vars, public, "Bob")
	cookies := []*http.Cookie{cookie}
	withCookie := func(_ context.Context, req *http.Request) error {
		req.AddCookie(cookies[0])
		return nil
	}
	beforeRes, err := c.GetMeWithResponse(t.Context(), withCookie)
	if err != nil || beforeRes.JSON200 == nil {
		t.Fatalf("GetMe before restart = %v, %v", beforeRes, err)
	}
	before := *beforeRes.JSON200
	posted, err := c.PostMessageWithResponse(t.Context(), roomID, api.PostMessageRequest{RequestKey: "k1", Body: "hello"}, withCookie)
	if err != nil || posted.StatusCode() != http.StatusCreated || posted.JSON201 == nil {
		t.Fatalf("PostMessage = %v, %v, want 201", posted, err)
	}

	stop()
	_, public = startServerOn(t, cfg, io.Discard)
	c, err = api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	me, err := c.GetMeWithResponse(t.Context(), withCookie)
	if err != nil {
		t.Fatalf("GetMe: %v", err)
	}
	if me.StatusCode() != http.StatusOK || me.JSON200 == nil || *me.JSON200 != before {
		t.Errorf("GetMe after restart = %d %s, want 200 with %+v", me.StatusCode(), me.Body, before)
	}
	rooms, err := c.ListRoomsWithResponse(t.Context(), withCookie)
	if err != nil {
		t.Fatalf("ListRooms: %v", err)
	}
	if rooms.StatusCode() != http.StatusOK || rooms.JSON200 == nil || len(rooms.JSON200.Rooms) != 1 ||
		rooms.JSON200.Rooms[0].Id != roomID || rooms.JSON200.Rooms[0].Name != "Lounge" {
		t.Errorf("ListRooms after restart = %d %s, want Lounge with ID %s", rooms.StatusCode(), rooms.Body, roomID)
	}
	history, err := c.ListMessagesWithResponse(t.Context(), roomID, nil, withCookie)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if history.StatusCode() != http.StatusOK || history.JSON200 == nil || len(history.JSON200.Messages) != 1 ||
		!reflect.DeepEqual(history.JSON200.Messages[0], *posted.JSON201) {
		t.Errorf("ListMessages after restart = %d %s, want only %+v", history.StatusCode(), history.Body, *posted.JSON201)
	}
}

// runCommand runs falky with args and returns its exit code and output.
func runCommand(t *testing.T, getenv func(string) string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code = run(t.Context(), args, getenv, nil, &out, &errOut)
	return code, out.String(), errOut.String()
}

// roomChanged reads the next event from ws and returns its room change,
// failing the test unless it is a room.changed event that comes within a
// second.
func roomChanged(t *testing.T, ws *websocket.Conn) api.RoomChange {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	_, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("no live update within a second: %v", err)
	}
	var e api.Event
	if err := json.Unmarshal(data, &e); err != nil || e.Type != api.EventTypeRoomChanged {
		t.Fatalf("live update %s (%v), want room.changed", data, err)
	}
	r, err := e.Payload.AsRoomChange()
	if err != nil {
		t.Fatalf("room.changed payload %s: %v", data, err)
	}
	return r
}

func TestRoomCommandsChangeTheRoomListAndTellConnectedVisitors(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:      filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket: filepath.Join(dir, "admin.sock"),
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	_, public := startServerOn(t, cfg, io.Discard)
	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	cookie := enterServer(t, vars, public, "Bob")
	listRooms := func() []api.Room {
		t.Helper()
		res, err := c.ListRoomsWithResponse(t.Context(), func(_ context.Context, req *http.Request) error {
			req.AddCookie(cookie)
			return nil
		})
		if err != nil || res.StatusCode() != http.StatusOK || res.JSON200 == nil {
			t.Fatalf("ListRooms = %v, %v, want 200", res, err)
		}
		return res.JSON200.Rooms
	}
	ws, _, err := websocket.Dial(t.Context(), public+"/api/live", &websocket.DialOptions{ //nolint:bodyclose // Dial closes the body on success
		HTTPHeader: http.Header{"Origin": {cfg.PublicOrigin}, "Cookie": {cookie.Name + "=" + cookie.Value}},
	})
	if err != nil {
		t.Fatalf("Dial /api/live: %v", err)
	}
	defer func() { _ = ws.CloseNow() }()

	code, out, stderr := runCommand(t, env(vars), "room", "create", "Lounge")
	id := strings.TrimSuffix(out, "\n")
	if code != 0 || id == "" || strings.ContainsAny(id, " \n") {
		t.Fatalf("room create = exit %d, stdout %q, stderr %q; want 0 and the ID on one line", code, out, stderr)
	}
	if rooms := listRooms(); len(rooms) != 1 || rooms[0].Id != id || rooms[0].Name != "Lounge" {
		t.Errorf("rooms after room create = %+v, want Lounge with ID %s", rooms, id)
	}
	if got := roomChanged(t, ws); got != (api.RoomChange{Id: id, Name: "Lounge"}) {
		t.Errorf("live update after room create = %+v, want Lounge with ID %s", got, id)
	}

	if code, out, stderr := runCommand(t, env(vars), "room", "rename", id, "Living room"); code != 0 || out != "" {
		t.Fatalf("room rename = exit %d, stdout %q, stderr %q; want 0 and no output", code, out, stderr)
	}
	if rooms := listRooms(); len(rooms) != 1 || rooms[0].Id != id || rooms[0].Name != "Living room" {
		t.Errorf("rooms after room rename = %+v, want Living room with ID %s", rooms, id)
	}
	if got := roomChanged(t, ws); got != (api.RoomChange{Id: id, Name: "Living room"}) {
		t.Errorf("live update after room rename = %+v, want Living room with ID %s", got, id)
	}

	if code, out, stderr := runCommand(t, env(vars), "room", "create", "living ROOM"); code == 0 || out != "" ||
		!strings.HasPrefix(stderr, "falky room create: ") || !strings.Contains(stderr, "another room has this name") {
		t.Errorf("room create with a taken name = exit %d, stdout %q, stderr %q; want non-zero and why", code, out, stderr)
	}
	unknown := "01JBX6Z8Q3M5W2K7R9T4V1C0DE"
	if code, out, stderr := runCommand(t, env(vars), "room", "rename", unknown, "Den"); code == 0 || out != "" ||
		!strings.HasPrefix(stderr, "falky room rename: ") || !strings.Contains(stderr, unknown) {
		t.Errorf("room rename of an unknown room = exit %d, stdout %q, stderr %q; want non-zero naming the ID", code, out, stderr)
	}
	if rooms := listRooms(); len(rooms) != 1 || rooms[0].Name != "Living room" {
		t.Errorf("rooms after the refusals = %+v, want only Living room", rooms)
	}
}

func TestRoomCommandsFailWhenNoServerIsRunning(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "admin.sock")
	getenv := env(map[string]string{platform.EnvAdminSocket: socket})
	for _, args := range [][]string{{"room", "create", "Lounge"}, {"room", "rename", "01JBX6Z8Q3M5W2K7R9T4V1C0DE", "Den"}} {
		if code, out, stderr := runCommand(t, getenv, args...); code == 0 || out != "" || !strings.Contains(stderr, "not running") {
			t.Errorf("%q = exit %d, stdout %q, stderr %q; want non-zero saying the server is not running", args, code, out, stderr)
		}
	}
}

func TestServeClosesLiveConnectionsWhenItStops(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:      filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket: filepath.Join(dir, "admin.sock"),
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	stop, public := startServerOn(t, cfg, io.Discard)
	cookie := enterServer(t, vars, public, "Bob")
	ws, _, err := websocket.Dial(t.Context(), public+"/api/live", &websocket.DialOptions{ //nolint:bodyclose // Dial closes the body on success
		HTTPHeader: http.Header{"Origin": {cfg.PublicOrigin}, "Cookie": {cookie.Name + "=" + cookie.Value}},
	})
	if err != nil {
		t.Fatalf("Dial /api/live: %v", err)
	}
	defer func() { _ = ws.CloseNow() }()
	closed := make(chan error, 1)
	go func() {
		_, _, err := ws.Read(context.Background())
		closed <- err
	}()

	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case err := <-closed:
		if websocket.CloseStatus(err) != websocket.StatusGoingAway {
			t.Errorf("live connection ended with %v, want close status going away", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("live connection still open 5 s after the server began to stop")
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}

func healthEnv(t *testing.T, ls listeners) func(string) string {
	t.Helper()
	_, port, err := net.SplitHostPort(ls.internal.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort: %v", err)
	}
	return env(map[string]string{
		platform.EnvInternalAddr: ":" + port,
		platform.EnvDBPath:       filepath.Join(t.TempDir(), "falky.db"),
	})
}

func TestHealthCommandSucceedsWhileTheServerIsReady(t *testing.T) {
	ls := newListeners(t, filepath.Join(t.TempDir(), "admin.sock"))
	getenv := healthEnv(t, ls)
	cfg, err := platform.LoadConfig(getenv)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	startServerWith(t, cfg, io.Discard, ls)

	if code, stdout, stderr := runCommand(t, getenv, "health", "live"); code != 0 {
		t.Errorf("health live = exit %d, stdout %q, stderr %q; want 0", code, stdout, stderr)
	}
	// No LiveKit is configured: the server is ready and says voice is degraded.
	code, stdout, stderr := runCommand(t, getenv, "health", "ready")
	if code != 0 || !strings.Contains(stdout, `"livekit":"degraded"`) {
		t.Errorf("health ready = exit %d, stdout %q, stderr %q; want 0 and the report naming livekit degraded", code, stdout, stderr)
	}
}

func TestHealthCommandFailsWhenNoServerIsRunning(t *testing.T) {
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	code, stdout, stderr := runCommand(t, env(map[string]string{platform.EnvInternalAddr: addr}), "health", "live")
	if code != 1 || stdout != "" || !strings.Contains(stderr, addr) {
		t.Errorf("health live = exit %d, stdout %q, stderr %q; want 1 and a message naming %s", code, stdout, stderr, addr)
	}
}

func TestARestoredSnapshotHasWhatWasPostedBeforeItAndKeepsTheVisitors(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:      filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket: filepath.Join(dir, "admin.sock"),
		platform.EnvSnapshotDir: filepath.Join(dir, "snapshots"),
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	stop, public := startServerOn(t, cfg, io.Discard)
	_, out, _ := runCommand(t, env(vars), "room", "create", "Lounge")
	roomID := strings.TrimSpace(out)
	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}

	// Visitors who keep posting, each as fast as the post limit lets them.
	var cookies []*http.Cookie
	for _, name := range []string{"Ann", "Bob", "Cy"} {
		cookies = append(cookies, enterServer(t, vars, public, name))
	}
	as := func(cookie *http.Cookie) api.RequestEditorFn {
		return func(_ context.Context, req *http.Request) error {
			req.AddCookie(cookie)
			return nil
		}
	}
	var posted sync.Map // body -> true, for every message posted
	post := func(cookie *http.Cookie, body string) bool {
		res, err := c.PostMessageWithResponse(t.Context(), roomID,
			api.PostMessageRequest{RequestKey: strings.ReplaceAll(body, " ", "-"), Body: body}, as(cookie))
		if err != nil {
			t.Errorf("PostMessage: %v", err)
			return false
		}
		if res.StatusCode() == http.StatusCreated {
			posted.Store(body, true)
		}
		return res.StatusCode() == http.StatusCreated
	}
	if !post(cookies[0], "before the snapshot") {
		t.Fatal("first message refused")
	}
	stopPosting := make(chan struct{})
	var posters sync.WaitGroup
	for i, cookie := range cookies {
		posters.Go(func() {
			for n := 0; ; n++ {
				select {
				case <-stopPosting:
					return
				default:
				}
				post(cookie, fmt.Sprintf("visitor %d message %d", i, n))
			}
		})
	}
	time.Sleep(50 * time.Millisecond)
	code, out, errOut := runCommand(t, env(vars), "snapshot")
	close(stopPosting)
	posters.Wait()
	if code != 0 {
		t.Fatalf("snapshot = exit %d, stderr %q", code, errOut)
	}
	snapshot := strings.TrimSpace(out)
	if filepath.Dir(snapshot) != vars[platform.EnvSnapshotDir] {
		t.Errorf("snapshot went to %q, want it in %s", snapshot, vars[platform.EnvSnapshotDir])
	}
	time.Sleep(time.Second) // past the post limit
	if !post(cookies[1], "after the snapshot") {
		t.Fatal("message after the snapshot refused")
	}
	stop()

	// Into an empty data directory, which the restore needs.
	restoredDir := t.TempDir()
	restoredVars := map[string]string{
		platform.EnvDBPath:      filepath.Join(restoredDir, "falky.db"),
		platform.EnvAdminSocket: filepath.Join(restoredDir, "admin.sock"),
	}
	restoreFrom := func(getenv func(string) string) (int, string) {
		f, err := os.Open(snapshot)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer func() { _ = f.Close() }()
		var stdout, stderr bytes.Buffer
		code := run(t.Context(), []string{"restore"}, getenv, f, &stdout, &stderr)
		return code, stdout.String() + stderr.String()
	}
	if code, out := restoreFrom(env(vars)); code != 1 || !strings.Contains(out, "already exists") {
		t.Errorf("restore over the old database = exit %d, %q; want a refusal", code, out)
	}
	if code, out := restoreFrom(env(restoredVars)); code != 0 {
		t.Fatalf("restore = exit %d, %q", code, out)
	}
	restoredCfg, err := platform.LoadConfig(env(restoredVars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	_, public = startServerOn(t, restoredCfg, io.Discard)
	c, err = api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	if me, err := c.GetMeWithResponse(t.Context(), as(cookies[2])); err != nil || me.StatusCode() != http.StatusOK {
		t.Errorf("GetMe with a cookie from before the snapshot = %v, %v; want 200", me, err)
	}
	limit := 100
	history, err := c.ListMessagesWithResponse(t.Context(), roomID, &api.ListMessagesParams{Limit: &limit}, as(cookies[0]))
	if err != nil || history.JSON200 == nil {
		t.Fatalf("ListMessages = %v, %v", history, err)
	}
	var bodies []string
	for _, m := range history.JSON200.Messages {
		if _, ok := posted.Load(m.Body); !ok {
			t.Errorf("restored message %q was never posted", m.Body)
		}
		bodies = append(bodies, m.Body)
	}
	if !slices.Contains(bodies, "before the snapshot") || slices.Contains(bodies, "after the snapshot") {
		t.Errorf("restored messages %q, want the one posted before the snapshot and not the one after", bodies)
	}
}

func TestServeFailsExplicitlyWhenColourInitializationCannotComplete(t *testing.T) {
	ls := newListeners(t, filepath.Join(t.TempDir(), "admin.sock"))
	logger := platform.NewLogger(io.Discard, 0)
	cfg := platform.Config{DBPath: filepath.Join(t.TempDir(), "falky.db")}
	db, ms, err := openMigrated(t.Context(), cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	err = serveOn(t.Context(), logger, cfg, db, ms, ls)
	if err == nil || !strings.Contains(err.Error(), "initialize visitor colours") {
		t.Fatalf("startup = %v, want explicit backfill failure", err)
	}
}

func TestAccountCommandsUseTheRunningServer(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{platform.EnvDBPath: filepath.Join(dir, "falky.db"), platform.EnvAdminSocket: filepath.Join(dir, "admin.sock"), platform.EnvPublicOrigin: "http://127.0.0.1:8080"}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatal(err)
	}
	_, public := startServerOn(t, cfg, io.Discard)
	code, out, stderr := runCommand(t, env(vars), "account", "list")
	if code != 0 || stderr != "" || strings.TrimSpace(out) != "[]" {
		t.Fatalf("account list = exit %d, %q, %q; want an empty list", code, out, stderr)
	}
	cookie := enterServer(t, vars, public, "Alice")
	code, out, _ = runCommand(t, env(vars), "account", "list")
	var accounts []struct {
		ID, Login, Name string
		Disabled        bool
	}
	if err := json.Unmarshal([]byte(out), &accounts); code != 0 || err != nil || len(accounts) != 1 || accounts[0].Login != "alice" || accounts[0].Name != "Alice" {
		t.Fatalf("account list = exit %d, %q, %v", code, out, err)
	}
	code, out, stderr = runCommand(t, env(vars), "account", "recover", "alice")
	if code != 0 || stderr != "" || !strings.Contains(out, "/#recover=") || !strings.Contains(out, "&account=alice") {
		t.Fatalf("account recover = exit %d, %q, %q", code, out, stderr)
	}
	me := func() int {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, public+"/api/me", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(cookie)
		res, err := (&http.Client{Transport: &http.Transport{DisableKeepAlives: true}}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res.StatusCode
	}
	// No LiveKit runs here, so emptying voice fails after the disable is
	// committed; the command says so, and the account stays disabled.
	runCommand(t, env(vars), "account", "disable", "alice")
	if status := me(); status != http.StatusUnauthorized {
		t.Errorf("GET /api/me after disabling = %d, want 401", status)
	}
	if code, _, stderr := runCommand(t, env(vars), "account", "enable", accounts[0].ID); code != 0 || stderr != "" {
		t.Fatalf("account enable = exit %d, %q", code, stderr)
	}
	if code, _, stderr := runCommand(t, env(vars), "account", "disable", "nobody"); code == 0 || stderr == "" {
		t.Errorf("account disable nobody = exit %d, %q; want a failure", code, stderr)
	}
}
