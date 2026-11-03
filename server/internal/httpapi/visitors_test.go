package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
)

// publicServer is the public listener over TLS (the visitor cookie is
// Secure) with real identity and rooms services on a temporary database.
type publicServer struct {
	srv    *httptest.Server
	secret string
	rooms  *rooms.Service
}

// startPublic serves the public listener, limiting entering to enterBurst
// attempts per client IP with no refill during the test.
func startPublic(t *testing.T, enterBurst int) publicServer {
	t.Helper()
	ms, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations())
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "falky.db"))
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
	ident := identity.New(db, "https://falky.example")
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatalf("EnsureLink: %v", err)
	}
	link, err := ident.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	logger := platform.NewLogger(io.Discard, 0)
	start := time.Now()
	rs := rooms.New(db)
	h := New(Deps{
		Logger:     logger,
		Health:     platform.NewHealth(logger),
		Metrics:    platform.NewMetrics().Handler(),
		Identity:   ident,
		Rooms:      rs,
		EnterLimit: platform.NewLimiter(enterBurst, time.Hour, func() time.Time { return start }),
	})
	srv := httptest.NewTLSServer(h.Public)
	t.Cleanup(srv.Close)
	return publicServer{srv: srv, secret: strings.TrimPrefix(link, "https://falky.example/#k="), rooms: rs}
}

// browser is a generated client with its own cookie jar, like one browser.
func (p publicServer) browser(t *testing.T) *api.ClientWithResponses {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	c, err := api.NewClientWithResponses(p.srv.URL,
		api.WithHTTPClient(&http.Client{Transport: p.srv.Client().Transport, Jar: jar}))
	if err != nil {
		t.Fatalf("NewClientWithResponses: %v", err)
	}
	return c
}

func forwardedFor(value string) api.RequestEditorFn {
	return func(_ context.Context, req *http.Request) error {
		req.Header.Set("X-Forwarded-For", value)
		return nil
	}
}

// enter enters as name through b and fails the test unless it succeeds.
func (p publicServer) enter(t *testing.T, b *api.ClientWithResponses, name string) api.Visitor {
	t.Helper()
	res, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: name})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	if res.StatusCode() != http.StatusCreated || res.JSON201 == nil {
		t.Fatalf("Enter(%q) = %d %s, want 201", name, res.StatusCode(), res.Body)
	}
	return *res.JSON201
}

func wantError(t *testing.T, what string, status int, body []byte, wantStatus int, wantCode string) {
	t.Helper()
	if status != wantStatus || !strings.Contains(string(body), `"code":"`+wantCode+`"`) {
		t.Errorf("%s = %d %s, want %d %s", what, status, body, wantStatus, wantCode)
	}
}

func TestEnteringSetsTheVisitorCookieAndMeReturnsTheVisitor(t *testing.T) {
	p := startPublic(t, 10)
	b := p.browser(t)
	res, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: " Bob "})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	if res.StatusCode() != http.StatusCreated || res.JSON201 == nil || res.JSON201.Name != "Bob" || res.JSON201.Id == "" {
		t.Fatalf("Enter = %d %s, want 201 with a visitor named Bob", res.StatusCode(), res.Body)
	}
	cookies := res.HTTPResponse.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("Enter set %d cookies, want 1", len(cookies))
	}
	c := cookies[0]
	if c.Name != "falky_visitor" || c.Value == "" || !c.HttpOnly || !c.Secure ||
		c.SameSite != http.SameSiteStrictMode || c.Path != "/api" || c.MaxAge <= 0 {
		t.Errorf("cookie = %s, want falky_visitor, HttpOnly, Secure, SameSite=Strict, Path=/api, persistent", c)
	}

	me, err := b.GetMeWithResponse(t.Context())
	if err != nil {
		t.Fatalf("GetMe: %v", err)
	}
	if me.StatusCode() != http.StatusOK || me.JSON200 == nil || *me.JSON200 != *res.JSON201 {
		t.Errorf("GetMe = %d %s, want 200 with %+v", me.StatusCode(), me.Body, *res.JSON201)
	}
}

func TestEnteringWithAWrongSecretIsRefusedWithoutACookie(t *testing.T) {
	p := startPublic(t, 10)
	b := p.browser(t)
	res, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: "wrong", Name: "Bob"})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	wantError(t, "Enter with a wrong secret", res.StatusCode(), res.Body, http.StatusForbidden, "invalid_link")
	if len(res.HTTPResponse.Cookies()) != 0 {
		t.Errorf("Enter with a wrong secret set cookies %v", res.HTTPResponse.Cookies())
	}
}

func TestEnteringRefusesReservedAndInvalidNames(t *testing.T) {
	p := startPublic(t, 10)
	p.enter(t, p.browser(t), "Bob")

	for name, want := range map[string]struct {
		status int
		code   string
	}{
		" bob ":                 {http.StatusConflict, "name_taken"},
		"   ":                   {http.StatusBadRequest, "invalid_name"},
		strings.Repeat("a", 33): {http.StatusBadRequest, "invalid_name"},
		"Bo\u0007b":             {http.StatusBadRequest, "invalid_name"},
	} {
		res, err := p.browser(t).EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: name})
		if err != nil {
			t.Fatalf("Enter: %v", err)
		}
		wantError(t, "Enter("+name+")", res.StatusCode(), res.Body, want.status, want.code)
		if len(res.HTTPResponse.Cookies()) != 0 {
			t.Errorf("refused Enter(%q) set cookies", name)
		}
	}
}

func TestEnteringIsLimitedPerForwardedClientIP(t *testing.T) {
	p := startPublic(t, 2)
	b := p.browser(t)
	attempt := func(forwarded string) *api.EnterResponse {
		t.Helper()
		res, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: "wrong", Name: "Bob"}, forwardedFor(forwarded))
		if err != nil {
			t.Fatalf("Enter: %v", err)
		}
		return res
	}

	for range 2 {
		if res := attempt("203.0.113.1"); res.StatusCode() != http.StatusForbidden {
			t.Fatalf("attempt within the limit = %d %s, want 403", res.StatusCode(), res.Body)
		}
	}
	res := attempt("203.0.113.1")
	wantError(t, "attempt beyond the limit", res.StatusCode(), res.Body, http.StatusTooManyRequests, "rate_limited")

	// The proxy appends the address it saw; earlier entries come from the
	// client and do not choose the bucket.
	res = attempt("198.51.100.7, 203.0.113.1")
	wantError(t, "attempt with a spoofed first entry", res.StatusCode(), res.Body, http.StatusTooManyRequests, "rate_limited")

	// Another client IP has its own limit, and the correct secret is limited
	// the same way.
	if res := attempt("203.0.113.2"); res.StatusCode() != http.StatusForbidden {
		t.Errorf("first attempt from another IP = %d %s, want 403", res.StatusCode(), res.Body)
	}
	limited, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: "Bob"}, forwardedFor("203.0.113.1"))
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	wantError(t, "correct secret beyond the limit", limited.StatusCode(), limited.Body, http.StatusTooManyRequests, "rate_limited")
}

func TestEnteringIsLimitedPerIPv6Network(t *testing.T) {
	p := startPublic(t, 2)
	b := p.browser(t)
	attempt := func(forwarded string) int {
		t.Helper()
		res, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: "wrong", Name: "Bob"}, forwardedFor(forwarded))
		if err != nil {
			t.Fatalf("Enter: %v", err)
		}
		return res.StatusCode()
	}

	// One client usually holds a whole /64, so its addresses share a limit.
	for _, ip := range []string{"2001:db8::1", "2001:db8::ffff:2"} {
		if got := attempt(ip); got != http.StatusForbidden {
			t.Fatalf("attempt from %s within the limit = %d, want 403", ip, got)
		}
	}
	if got := attempt("2001:db8::3"); got != http.StatusTooManyRequests {
		t.Errorf("attempt from the same /64 beyond the limit = %d, want 429", got)
	}
	if got := attempt("2001:db8:0:1::1"); got != http.StatusForbidden {
		t.Errorf("attempt from another /64 = %d, want 403", got)
	}
}

func TestOversizedRequestBodiesAreRefused(t *testing.T) {
	p := startPublic(t, 10)
	res, err := p.browser(t).EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: strings.Repeat("a", 1<<20)})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	wantError(t, "Enter with a 1 MiB name", res.StatusCode(), res.Body, http.StatusBadRequest, "invalid_request")
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
	want := api.Visitor{Id: me.Id, Name: "Rob"}
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
