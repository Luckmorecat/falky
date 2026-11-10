package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/voice"
)

type accountResponse struct {
	Header  http.Header
	Cookies []*http.Cookie
}

// accountRequest sends body as JSON to path through c, from origin when it is
// not empty and from an address no other request used, and fails the test
// unless the status is want.
func accountRequest(t *testing.T, p publicServer, c *http.Client, method, path string, body any, origin string, want int) ([]byte, accountResponse) {
	t.Helper()
	var b []byte
	if body != nil {
		var err error
		b, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequestWithContext(t.Context(), method, p.srv.URL+path, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if err := newClientIP()(t.Context(), req); err != nil {
		t.Fatal(err)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := res.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != want {
		t.Fatalf("%s %s status %d %s, want %d", method, path, res.StatusCode, raw, want)
	}
	return raw, accountResponse{Header: res.Header, Cookies: res.Cookies()}
}

type enrolledAccount struct {
	Session struct {
		Visitor struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"visitor"`
		Kind string `json:"kind"`
	} `json:"session"`
}

// registerAccount gives the access password and registers name through c,
// with a login made from it, and returns the enrollment.
func registerAccount(t *testing.T, p publicServer, c *http.Client, name string) enrolledAccount {
	t.Helper()
	accountRequest(t, p, c, http.MethodPost, "/api/access", map[string]any{"password": testAccessPassword}, testOrigin, http.StatusOK)
	raw, res := accountRequest(t, p, c, http.MethodPost, "/api/accounts/register", map[string]any{"login": loginFor(name), "password": testPassword, "name": name}, testOrigin, http.StatusOK)
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("an account response can be cached")
	}
	var result enrolledAccount
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Session.Kind != "account" {
		t.Fatalf("registered session = %+v", result.Session)
	}
	return result
}

// loginAccountBrowser signs a new browser in to login with testPassword.
func loginAccountBrowser(t *testing.T, p publicServer, login string) (*api.ClientWithResponses, *http.Client) {
	t.Helper()
	client, browser := p.browserWithHTTP(t)
	accountRequest(t, p, browser, http.MethodPost, "/api/access", map[string]any{"password": testAccessPassword}, testOrigin, http.StatusOK)
	accountRequest(t, p, browser, http.MethodPost, "/api/accounts/login", map[string]any{"login": login, "password": testPassword}, testOrigin, http.StatusOK)
	return client, browser
}

// recoveryCode has the operator issue a recovery code for login.
func (p publicServer) recoveryCode(t *testing.T, login string) string {
	t.Helper()
	grant, err := p.identity.IssueRecovery(t.Context(), login)
	if err != nil {
		t.Fatal(err)
	}
	return grant.Token
}

func restartVoice(t *testing.T, p publicServer) publicServer {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	t.Cleanup(upstream.Close)
	p.voice = voice.New(p.livekit, p.identity, p.rooms, voice.Config{URL: testLiveKitURL, APIKey: testLiveKitKey, APISecret: testLiveKitSecret, RoomCap: testRoomCap}, voice.WithDB(p.db))
	p.lifecycle = &Lifecycle{}
	handlers := New(Deps{Identity: p.identity, Voice: p.voice, Rooms: p.rooms, Live: p.events.Hub, Logger: p.events.Logger, Lifecycle: p.lifecycle, PublicOrigin: testOrigin, LiveKitAPIURL: upstream.URL, Metrics: platform.NewMetrics().Handler(), AuthLimit: platform.NewLimiter(100, time.Hour, time.Now)})
	p.srv = httptest.NewTLSServer(handlers.Public)
	t.Cleanup(p.srv.Close)
	return p
}

func checkVoiceValidation(t *testing.T, p publicServer, token string, want int) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.srv.URL+"/rtc/validate?access_token="+url.QueryEscape(token), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := p.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != want {
		t.Fatalf("RTC validation after restart = %d, want %d", res.StatusCode, want)
	}
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

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
