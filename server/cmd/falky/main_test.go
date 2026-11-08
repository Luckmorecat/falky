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
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
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

func TestMigrateCommandIsIdempotentAndCreatesTheLinkOnce(t *testing.T) {
	getenv := env(map[string]string{platform.EnvDBPath: filepath.Join(t.TempDir(), "falky.db")})
	for i, wantCreated := range []bool{true, false} {
		var stdout, stderr bytes.Buffer
		if code := run(t.Context(), []string{"migrate"}, getenv, nil, &stdout, &stderr); code != 0 {
			t.Fatalf("migrate run %d: exit %d, stdout %q, stderr %q", i+1, code, stdout.String(), stderr.String())
		}
		if created := strings.Contains(stdout.String(), "access link created"); created != wantCreated {
			t.Errorf("migrate run %d: link created = %v, want %v; logs %q", i+1, created, wantCreated, stdout.String())
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

// runLinkShow runs falky link show and returns its exit code and output.
func runLinkShow(t *testing.T, getenv func(string) string) (code int, stdout, stderr string) {
	t.Helper()
	return runCommand(t, getenv, "link", "show")
}

func TestLinkShowPrintsTheSameLinkAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:       filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket:  filepath.Join(dir, "admin.sock"),
		platform.EnvPublicOrigin: "https://falky.example",
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	var logs syncBuffer
	stop := startServer(t, cfg, &logs)

	code, link, stderr := runLinkShow(t, env(vars))
	if code != 0 || !strings.HasPrefix(link, "https://falky.example/#k=") || !strings.HasSuffix(link, "\n") {
		t.Fatalf("link show = exit %d, stdout %q, stderr %q; want 0 and the link on one line", code, link, stderr)
	}
	if code, again, _ := runLinkShow(t, env(vars)); code != 0 || again != link {
		t.Errorf("second link show = exit %d, %q, want 0, %q", code, again, link)
	}

	stop()
	if _, err := os.Lstat(cfg.AdminSocket); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("admin socket after shutdown: Lstat = %v, want it removed", err)
	}
	startServer(t, cfg, &logs)
	if code, again, _ := runLinkShow(t, env(vars)); code != 0 || again != link {
		t.Errorf("link show after restart = exit %d, %q, want 0, %q", code, again, link)
	}

	secret := strings.TrimSpace(strings.TrimPrefix(link, "https://falky.example/#k="))
	if strings.Contains(logs.String(), secret) {
		t.Errorf("server logs contain the link secret: %q", logs.String())
	}
}

func TestLinkShowFailsWhenNoServerIsRunning(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "admin.sock")
	code, stdout, stderr := runLinkShow(t, env(map[string]string{platform.EnvAdminSocket: socket}))
	if code == 0 || stdout != "" || !strings.Contains(stderr, "not running") || !strings.Contains(stderr, socket) {
		t.Errorf("link show = exit %d, stdout %q, stderr %q; want non-zero, no link, and a message naming %s", code, stdout, stderr, socket)
	}
}

func TestRunRefusesUnknownCommands(t *testing.T) {
	for _, args := range [][]string{
		nil,
		{"frobnicate"},
		{"serve", "extra"},
		{"link"},
		{"link", "rotate", "extra"},
		{"link", "show", "extra"},
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
	_, link, _ := runLinkShow(t, env(vars))
	secret := strings.TrimSpace(link[strings.Index(link, "#k=")+len("#k="):])
	_, out, _ := runCommand(t, env(vars), "room", "create", "Lounge")
	roomID := strings.TrimSpace(out)

	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	entered, err := c.EnterWithResponse(t.Context(), api.EnterRequest{Secret: secret, Name: "Bob"})
	if err != nil || entered.StatusCode() != http.StatusCreated || entered.JSON201 == nil {
		t.Fatalf("Enter = %v, %v, want 201", entered, err)
	}
	cookies := entered.HTTPResponse.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("Enter set %d cookies, want 1", len(cookies))
	}
	withCookie := func(_ context.Context, req *http.Request) error {
		req.AddCookie(cookies[0])
		return nil
	}
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
	if me.StatusCode() != http.StatusOK || me.JSON200 == nil || *me.JSON200 != *entered.JSON201 {
		t.Errorf("GetMe after restart = %d %s, want 200 with %+v", me.StatusCode(), me.Body, *entered.JSON201)
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
		history.JSON200.Messages[0] != *posted.JSON201 {
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
	_, link, _ := runLinkShow(t, env(vars))
	secret := strings.TrimSpace(link[strings.Index(link, "#k=")+len("#k="):])
	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	entered, err := c.EnterWithResponse(t.Context(), api.EnterRequest{Secret: secret, Name: "Bob"})
	if err != nil || entered.StatusCode() != http.StatusCreated {
		t.Fatalf("Enter = %v, %v, want 201", entered, err)
	}
	cookie := entered.HTTPResponse.Cookies()[0]
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
	_, link, _ := runLinkShow(t, env(vars))
	secret := strings.TrimSpace(link[strings.Index(link, "#k=")+len("#k="):])
	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	entered, err := c.EnterWithResponse(t.Context(), api.EnterRequest{Secret: secret, Name: "Bob"})
	if err != nil || entered.StatusCode() != http.StatusCreated {
		t.Fatalf("Enter = %v, %v, want 201", entered, err)
	}
	cookie := entered.HTTPResponse.Cookies()[0]
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

func TestLinkRotateReplacesTheLinkAndEndsTheOldOnesAccess(t *testing.T) {
	dir := t.TempDir()
	vars := map[string]string{
		platform.EnvDBPath:      filepath.Join(dir, "falky.db"),
		platform.EnvAdminSocket: filepath.Join(dir, "admin.sock"),
	}
	cfg, err := platform.LoadConfig(env(vars))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	var logs syncBuffer
	_, public := startServerOn(t, cfg, &logs)
	_, link, _ := runLinkShow(t, env(vars))
	secretOf := func(link string) string { return strings.TrimSpace(link[strings.Index(link, "#k=")+len("#k="):]) }
	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	entered, err := c.EnterWithResponse(t.Context(), api.EnterRequest{Secret: secretOf(link), Name: "Bob"})
	if err != nil || entered.StatusCode() != http.StatusCreated {
		t.Fatalf("Enter = %v, %v, want 201", entered, err)
	}
	cookie := entered.HTTPResponse.Cookies()[0]
	withCookie := func(_ context.Context, req *http.Request) error {
		req.AddCookie(cookie)
		return nil
	}
	ws, _, err := websocket.Dial(t.Context(), public+"/api/live", &websocket.DialOptions{ //nolint:bodyclose // Dial closes the body on success
		HTTPHeader: http.Header{"Origin": {cfg.PublicOrigin}, "Cookie": {cookie.Name + "=" + cookie.Value}},
	})
	if err != nil {
		t.Fatalf("Dial /api/live: %v", err)
	}
	defer func() { _ = ws.CloseNow() }()

	// No LiveKit is configured, so voice cannot be emptied; the rotation
	// still succeeds.
	start := time.Now()
	code, rotated, stderr := runCommand(t, env(vars), "link", "rotate")
	if code != 0 || rotated == link || !strings.Contains(rotated, "/#k=") || !strings.HasSuffix(rotated, "\n") {
		t.Fatalf("link rotate = exit %d, stdout %q, stderr %q; want 0 and a new link on one line (was %q)", code, rotated, stderr, link)
	}
	if _, shown, _ := runLinkShow(t, env(vars)); shown != rotated {
		t.Errorf("link show after rotating = %q, want %q", shown, rotated)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	_, data, err := ws.Read(ctx)
	var e api.Event
	if err != nil || json.Unmarshal(data, &e) != nil || e.Type != api.EventTypeAccessRevoked {
		t.Errorf("live update after rotating = %s, %v; want access.revoked", data, err)
	}
	if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) != realtime.StatusRevoked {
		t.Errorf("read after access.revoked = %v, want close status %d", err, realtime.StatusRevoked)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("rotation took %v to reach the live connection, want at most two seconds", elapsed)
	}

	if me, err := c.GetMeWithResponse(t.Context(), withCookie); err != nil || me.StatusCode() != http.StatusUnauthorized {
		t.Errorf("GetMe with the old cookie = %v, %v, want 401", me, err)
	}
	if old, err := c.EnterWithResponse(t.Context(), api.EnterRequest{Secret: secretOf(link), Name: "Ann"}); err != nil ||
		old.StatusCode() != http.StatusForbidden {
		t.Errorf("Enter with the old secret = %v, %v, want 403", old, err)
	}
	again, err := c.EnterWithResponse(t.Context(), api.EnterRequest{Secret: secretOf(rotated), Name: "Bob"})
	if err != nil || again.StatusCode() != http.StatusCreated || again.JSON201 == nil || again.JSON201.Id == entered.JSON201.Id {
		t.Errorf("Enter with the new secret = %v, %v, want 201 and a new visitor", again, err)
	}
	if !strings.Contains(logs.String(), "voice not emptied") {
		t.Errorf("logs = %q, want voice reported not emptied", logs.String())
	}
	for _, l := range []string{link, rotated} {
		if strings.Contains(logs.String(), secretOf(l)) {
			t.Errorf("server logs contain a link secret: %q", logs.String())
		}
	}
}

func TestLinkRotateFailsWhenNoServerIsRunning(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "admin.sock")
	code, stdout, stderr := runCommand(t, env(map[string]string{platform.EnvAdminSocket: socket}), "link", "rotate")
	if code == 0 || stdout != "" || !strings.Contains(stderr, "not running") {
		t.Errorf("link rotate = exit %d, stdout %q, stderr %q; want non-zero saying the server is not running", code, stdout, stderr)
	}
}

// healthEnv returns the environment of a server whose internal listener is
// ls.internal, named by port only as the image names it.
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
	_, link, _ := runLinkShow(t, env(vars))
	secret := strings.TrimSpace(link[strings.Index(link, "#k=")+len("#k="):])
	_, out, _ := runCommand(t, env(vars), "room", "create", "Lounge")
	roomID := strings.TrimSpace(out)
	c, err := api.NewClientWithResponses(public)
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}

	// Visitors who keep posting, each as fast as the post limit lets them.
	var cookies []*http.Cookie
	for _, name := range []string{"Ann", "Bob", "Cy"} {
		entered, err := c.EnterWithResponse(t.Context(), api.EnterRequest{Secret: secret, Name: name})
		if err != nil || entered.StatusCode() != http.StatusCreated || len(entered.HTTPResponse.Cookies()) != 1 {
			t.Fatalf("Enter %s = %v, %v, want 201 with a cookie", name, entered, err)
		}
		cookies = append(cookies, entered.HTTPResponse.Cookies()[0])
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
	if _, got, _ := runLinkShow(t, env(restoredVars)); got != link {
		t.Errorf("link after restore = %q, want %q", got, link)
	}
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
