package httpapi

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/attachments"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

// publicServer is the public listener over TLS (the visitor cookie is
// Secure) with real identity, rooms, chat and voice services on a temporary
// database, voice over an in-memory LiveKit, and the internal listener
// beside it.
type publicServer struct {
	db          *platform.DB
	srv         *httptest.Server
	internal    *httptest.Server
	identity    *identity.Service
	rooms       *rooms.Service
	voice       *voice.Service
	lifecycle   *Lifecycle
	livekit     *voicetest.LiveKit
	events      Events
	attachments *attachments.Store
	// clock is the time identity reads, which the test moves by hand.
	clock *clock
	// logs holds what the server logged.
	logs *syncBuffer
}

// syncBuffer is a bytes.Buffer that is safe for concurrent use.
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

// clock is a time source the test moves by hand.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// Voice settings of the test server.
const (
	testLiveKitURL    = "wss://falky.example"
	testLiveKitKey    = "falky"
	testLiveKitSecret = "a-secret-of-at-least-32-characters"
	testRoomCap       = 8
)

// startPublic serves the public listener, limiting entering to enterBurst
// attempts per client IP with no refill during the test, and posting
// generously.
func startPublic(t *testing.T, enterBurst int) publicServer {
	t.Helper()
	return startPublicLimited(t, enterBurst, 1000)
}

// startPublicLimited is startPublic that also limits posting to postBurst
// messages per visitor with no refill during the test.
func startPublicLimited(t *testing.T, enterBurst, postBurst int, identityOptions ...identity.Option) publicServer {
	t.Helper()
	return startPublicAttachments(t, enterBurst, postBurst, nil, identityOptions...)
}

func startPublicAttachments(t *testing.T, enterBurst, postBurst int, attachmentOptions []attachments.Option, identityOptions ...identity.Option) publicServer {
	t.Helper()
	ms, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations(), chat.Migrations(), attachments.Migrations(), voice.Migrations())
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "falky.db"), platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	clk := &clock{now: time.Now()}
	ident := identity.New(db, testOrigin, append([]identity.Option{cheapPasswords, identity.WithClock(clk.Now)}, identityOptions...)...)
	if err := ident.InitializeColours(t.Context()); err != nil {
		t.Fatalf("InitializeColours: %v", err)
	}
	if err := ident.SetAccessPassword(t.Context(), testAccessPassword); err != nil {
		t.Fatalf("SetAccessPassword: %v", err)
	}
	logs := &syncBuffer{}
	logger := platform.NewLogger(logs, 0)
	start := time.Now()
	hub := realtime.New(realtime.WithConnectedFunc(ident.ColourConnected))
	events := Events{Hub: hub, Logger: logger}
	store, err := attachments.New(db, filepath.Join(t.TempDir(), "attachments"), append([]attachments.Option{attachments.WithClock(clk.Now), attachments.WithExpiryPublisher(events.AttachmentsExpired)}, attachmentOptions...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	rs := rooms.New(db, rooms.WithPublisher(events.RoomChanged), rooms.WithNameCheck(ident.NameTaken))
	lk := voicetest.New()
	vs := voice.New(lk, ident, rs, voice.Config{
		URL: testLiveKitURL, APIKey: testLiveKitKey, APISecret: testLiveKitSecret, RoomCap: testRoomCap,
	}, voice.WithDB(db), voice.WithPublisher(events.OccupancyChanged))
	lifecycle := &Lifecycle{}
	h := New(Deps{
		Lifecycle:   lifecycle,
		Logger:      logger,
		Health:      platform.NewHealth(logger),
		Metrics:     platform.NewMetrics().Handler(),
		Identity:    ident,
		Attachments: store,
		Rooms:       rs,
		Voice:       vs,
		Chat: chat.New(db,
			chat.WithAttachments(store),
			chat.WithPostLimit(platform.NewLimiter(postBurst, time.Hour, func() time.Time { return start })),
			chat.WithPublisher(events.MessageCreated)),
		AuthLimit:    platform.NewLimiter(enterBurst, time.Hour, func() time.Time { return start }),
		LoginLimit:   platform.NewLimiter(enterBurst, time.Hour, func() time.Time { return start }),
		Live:         hub,
		PublicOrigin: testOrigin,
	})
	srv := httptest.NewTLSServer(h.Public)
	t.Cleanup(srv.Close)
	internal := httptest.NewServer(h.Internal)
	t.Cleanup(internal.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.Shutdown(ctx); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	})
	return publicServer{
		db: db, srv: srv, internal: internal,
		identity: ident, rooms: rs, attachments: store, voice: vs, livekit: lk, events: events, clock: clk, logs: logs, lifecycle: lifecycle,
	}
}

// testOrigin is the public origin the test server is configured with.
const testOrigin = "https://falky.example"

// browser is a generated client with its own cookie jar, like one browser.
func (p publicServer) browser(t *testing.T) *api.ClientWithResponses {
	t.Helper()
	c, _ := p.browserWithHTTP(t)
	return c
}

// browserWithHTTP is browser that also returns the HTTP client, which holds
// the cookie jar.
func (p publicServer) browserWithHTTP(t *testing.T) (*api.ClientWithResponses, *http.Client) {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	hc := &http.Client{Transport: p.srv.Client().Transport, Jar: jar}
	// A browser sends its page's origin, which account changes and voice require.
	c, err := api.NewClientWithResponses(p.srv.URL, api.WithHTTPClient(hc), api.WithRequestEditorFn(sameOrigin))
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	return c, hc
}

func forwardedFor(value string) api.RequestEditorFn {
	return func(_ context.Context, req *http.Request) error {
		req.Header.Set("X-Forwarded-For", value)
		return nil
	}
}

// The access password every test server starts with, the password test
// accounts register with, and a cheap hash cost that keeps tests fast.
const (
	testAccessPassword = "shared secret phrase"
	testPassword       = "correct horse battery"
)

var cheapPasswords = identity.WithPasswordCost(identity.PasswordCost{Time: 1, MemoryKiB: 64})

var notLogin = regexp.MustCompile(`[^a-z0-9]+`)

// loginFor turns a test name into a valid login: "Visitor 3" is visitor-3.
func loginFor(name string) string {
	login := strings.Trim(notLogin.ReplaceAllString(strings.ToLower(name), "-"), "-")
	for len(login) < identity.MinLoginLength {
		login += "x"
	}
	return login
}

var clientCount atomic.Uint32

// newClientIP is a forwarded address no other request of the test run used,
// so the per-address limit on account requests never interferes.
func newClientIP() api.RequestEditorFn {
	n := clientCount.Add(1)
	return forwardedFor(fmt.Sprintf("10.%d.%d.%d", n>>16&255, n>>8&255, n&255))
}

func sameOrigin(_ context.Context, req *http.Request) error {
	req.Header.Set("Origin", testOrigin)
	return nil
}

// passAccess gives the access password through b and fails the test unless
// it is accepted.
func (p publicServer) passAccess(t *testing.T, b *api.ClientWithResponses) {
	t.Helper()
	res, err := b.PassAccessWithResponse(t.Context(), api.PassAccessJSONRequestBody{Password: testAccessPassword}, sameOrigin, newClientIP())
	if err != nil || res.StatusCode() != http.StatusOK {
		t.Fatalf("PassAccess = %v %v", res.StatusCode(), err)
	}
}

// registerDirect registers name on the identity service directly, without
// HTTP, and returns the account's identity and session token.
func (p publicServer) registerDirect(t *testing.T, name string) (identity.Visitor, string, error) {
	t.Helper()
	pass, err := p.identity.PassAccess(t.Context(), testAccessPassword)
	if err != nil {
		return identity.Visitor{}, "", err
	}
	e, err := p.identity.Register(t.Context(), identity.RegistrationInput{AccessToken: pass, Login: loginFor(name), Password: testPassword, Name: name})
	return e.Session.Visitor, e.Token, err
}

// revokeAll disables every account, as the operator might, without
// enforcing it on live updates or voice.
func (p publicServer) revokeAll(t *testing.T) {
	t.Helper()
	accounts, err := p.identity.Accounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range accounts {
		if _, err := p.identity.DisableAccount(t.Context(), a.ID); err != nil {
			t.Fatal(err)
		}
	}
}

// enter gives the access password and registers name through b, with a login
// made from it, and fails the test unless both succeed.
func (p publicServer) enter(t *testing.T, b *api.ClientWithResponses, name string) api.Visitor {
	t.Helper()
	p.passAccess(t, b)
	res, err := b.RegisterWithResponse(t.Context(), api.RegisterJSONRequestBody{Login: loginFor(name), Password: testPassword, Name: name}, sameOrigin, newClientIP())
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil {
		t.Fatalf("Register(%q) = %d %s, want 200", name, res.StatusCode(), res.Body)
	}
	return res.JSON200.Session.Visitor
}

func wantError(t *testing.T, what string, status int, body []byte, wantStatus int, wantCode string) {
	t.Helper()
	if status != wantStatus || !strings.Contains(string(body), `"code":"`+wantCode+`"`) {
		t.Errorf("%s = %d %s, want %d %s", what, status, body, wantStatus, wantCode)
	}
}

func TestOversizedRequestBodiesAreRefused(t *testing.T) {
	p := startPublic(t, 10)
	res, err := p.browser(t).PassAccessWithResponse(t.Context(), api.PassAccessJSONRequestBody{Password: strings.Repeat("a", 1<<20)}, sameOrigin)
	if err != nil {
		t.Fatalf("PassAccess: %v", err)
	}
	wantError(t, "PassAccess with a 1 MiB password", res.StatusCode(), res.Body, http.StatusRequestEntityTooLarge, "invalid_request")
}

func TestMeNeedsAValidVisitorCookie(t *testing.T) {
	p := startPublic(t, 10)
	unknownCookie := func(_ context.Context, req *http.Request) error {
		req.AddCookie(&http.Cookie{Name: "falky_visitor", Value: "UNKNOWNTOKEN"})
		return nil
	}
	for name, editors := range map[string][]api.RequestEditorFn{
		"no cookie":      nil,
		"unknown cookie": {unknownCookie},
	} {
		b := p.browser(t)
		get, err := b.GetMeWithResponse(t.Context(), editors...)
		if err != nil {
			t.Fatalf("GetMe: %v", err)
		}
		wantError(t, "GetMe with "+name, get.StatusCode(), get.Body, http.StatusUnauthorized, "visitor_required")
		patch, err := b.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: "Rob"}, editors...)
		if err != nil {
			t.Fatalf("RenameMe: %v", err)
		}
		wantError(t, "RenameMe with "+name, patch.StatusCode(), patch.Body, http.StatusUnauthorized, "visitor_required")
	}
}

func TestRenamingMeChangesTheNameUnlessItIsTakenOrInvalid(t *testing.T) {
	p := startPublic(t, 10)
	bob := p.browser(t)
	me := p.enter(t, bob, "Bob")
	p.enter(t, p.browser(t), "Ann")

	for name, want := range map[string]struct {
		status int
		code   string
	}{
		"ANN": {http.StatusConflict, "name_taken"},
		"":    {http.StatusBadRequest, "invalid_name"},
	} {
		res, err := bob.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: name})
		if err != nil {
			t.Fatalf("RenameMe: %v", err)
		}
		wantError(t, "RenameMe("+name+")", res.StatusCode(), res.Body, want.status, want.code)
	}

	res, err := bob.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: " Rob "})
	if err != nil {
		t.Fatalf("RenameMe: %v", err)
	}
	want := api.Visitor{Id: me.Id, Name: "Rob", Colour: me.Colour}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil || *res.JSON200 != want {
		t.Fatalf("RenameMe(Rob) = %d %s, want 200 with %+v", res.StatusCode(), res.Body, want)
	}
	got, err := bob.GetMeWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetMe: %v", err)
	}
	if got.StatusCode() != http.StatusOK || got.JSON200 == nil || *got.JSON200 != want {
		t.Errorf("GetMe after renaming = %d %s, want 200 with %+v", got.StatusCode(), got.Body, want)
	}
}
