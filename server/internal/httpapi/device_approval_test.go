package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
)

type (
	wireSignInRequest struct {
		ID        string    `json:"id"`
		Type      string    `json:"type"`
		State     string    `json:"state"`
		Version   int64     `json:"version"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	wireSignInBegin struct {
		Request wireSignInRequest `json:"request"`
		Code    string            `json:"code"`
		Token   string            `json:"token"`
		URL     string            `json:"url"`
	}
	wireSignInLink struct {
		Link struct {
			ID       string              `json:"id"`
			Requests []wireSignInRequest `json:"requests"`
		} `json:"link"`
		Token string `json:"token"`
		URL   string `json:"url"`
	}
)

func decodeSignIn[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestDeviceApprovalLinkHTTPDeliveryAndBinding(t *testing.T) {
	p := startPublic(t, 100)
	_, issuer := p.browserWithHTTP(t)
	enrollAccount(t, p, issuer, "Account", passkeytest.New(t))
	raw, _ := accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 200)
	link := decodeSignIn[wireSignInLink](t, raw)
	if link.Link.ID == "" || link.URL != testOrigin+"/#signin="+link.Token {
		t.Fatalf("invalid link: %s", raw)
	}
	_, candidate := p.browserWithHTTP(t)
	raw, res := accountRequest(t, p, candidate, "POST", "/api/accounts/signin-requests", map[string]any{"token": link.Token}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	if len(begin.Code) != 4 || begin.Request.State != "pending" || begin.Request.Type != "link" || begin.Request.Version != 1 {
		t.Fatalf("invalid begin: %s", raw)
	}
	found := false
	for _, c := range res.Cookies {
		if c.Name == "__Host-falky-signin" {
			found = true
			if !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Domain != "" || c.MaxAge != 600 || len(c.Value) != 52 || strings.Contains(string(raw), c.Value) {
				t.Fatal("unsafe signin binding")
			}
		}
	}
	if !found || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("binding/privacy headers absent")
	}
	path := "/api/accounts/signin-requests/" + begin.Request.ID
	accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links/"+link.Link.ID+"/approve", map[string]any{"code": begin.Code}, testOrigin, 200)
	raw, res = accountRequest(t, p, candidate, "POST", path+"/finish", map[string]any{"token": link.Token}, testOrigin, 200)
	if !strings.Contains(string(raw), `"kind":"account"`) {
		t.Fatalf("finish = %s", raw)
	}
	token := ""
	for _, c := range res.Cookies {
		if c.Name == cookieName {
			token = c.Value
			if c.MaxAge > 90*24*60*60 || c.MaxAge < 90*24*60*60-5 {
				t.Fatalf("session lifetime = %d", c.MaxAge)
			}
		}
	}
	if token == "" {
		t.Fatal("missing session delivery")
	}
	accountRequest(t, p, candidate, "POST", path+"/finish", map[string]any{"token": link.Token}, testOrigin, 200)
	accountRequest(t, p, candidate, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	raw, _ = accountRequest(t, p, candidate, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	if decodeSignIn[wireSignInBegin](t, raw).Request.ID == "" {
		t.Fatal("signin binding lost")
	}
}

func TestDeviceQRHTTPControlsAndGuestRetryConflict(t *testing.T) {
	p := startPublic(t, 100)
	_, phone := p.browserWithHTTP(t)
	enrollAccount(t, p, phone, "Account", passkeytest.New(t))
	guestAPI, browser := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	if begin.Code != "" || begin.URL != testOrigin+"/#qr-signin="+begin.Token {
		t.Fatalf("QR = %s", raw)
	}
	path := "/api/accounts/signin-requests/" + begin.Request.ID
	raw, _ = accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/preview", map[string]any{"token": begin.Token}, testOrigin, 200)
	if decodeSignIn[struct {
		Request wireSignInRequest `json:"request"`
	}](t, raw).Request.State != "pending" {
		t.Fatal("preview claimed request")
	}
	accountRequest(t, p, browser, "POST", path+"/resend", map[string]any{"token": begin.Token}, testOrigin, 403)
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/approve", map[string]any{"token": begin.Token}, testOrigin, 200)
	accountRequest(t, p, browser, "POST", path+"/finish", map[string]any{}, testOrigin, 200)
	p.enter(t, guestAPI, "New guest")
	raw, res := accountRequest(t, p, browser, "POST", path+"/finish", map[string]any{}, testOrigin, 409)
	if !strings.Contains(string(raw), `"code":"signin_conflict"`) || len(res.Cookies) != 0 {
		t.Fatalf("guest overwritten: %s %v", raw, res.Cookies)
	}
	accountRequest(t, p, browser, "GET", "/api/me", nil, "", 200)
	accountRequest(t, p, browser, "DELETE", "/api/accounts/qr-signins/"+begin.Request.ID, nil, testOrigin, 409)
	_, other := p.browserWithHTTP(t)
	raw, _ = accountRequest(t, p, other, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	denied := decodeSignIn[wireSignInBegin](t, raw)
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/deny", map[string]any{"token": denied.Token}, testOrigin, 200)
	accountRequest(t, p, other, "GET", "/api/accounts/signin-requests/"+denied.Request.ID, nil, "", 200)
}

func TestDeviceLinkHTTPErrorsCooldownAndCommittedRejection(t *testing.T) {
	nextCode := 9999
	p := startPublicLimited(t, 100, 1000, identity.WithSignInCodeGenerator(func() (string, error) {
		code := fmt.Sprintf("%04d", nextCode)
		nextCode--
		return code, nil
	}))
	_, issuer := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, issuer, "Account", key)
	_, peer := loginAccountBrowser(t, p, key)
	raw, _ := accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 200)
	link := decodeSignIn[wireSignInLink](t, raw)
	base := "/api/accounts/signin-links/" + link.Link.ID
	accountRequest(t, p, peer, "GET", base, nil, "", 403)
	accountRequest(t, p, peer, "POST", base+"/approve", map[string]any{"code": "0000"}, testOrigin, 403)
	var waiting []wireSignInBegin
	var browsers []*http.Client
	for i := range 3 {
		_, b := p.browserWithHTTP(t)
		raw, _ = accountRequest(t, p, b, "POST", "/api/accounts/signin-requests", map[string]any{"token": link.Token}, testOrigin, 200)
		begin := decodeSignIn[wireSignInBegin](t, raw)
		if begin.Code != fmt.Sprintf("%04d", 9999-i) {
			t.Fatalf("allocated code = %s, want deterministic collision case", begin.Code)
		}
		waiting = append(waiting, begin)
		browsers = append(browsers, b)
	}
	_, extra := p.browserWithHTTP(t)
	raw, _ = accountRequest(t, p, extra, "POST", "/api/accounts/signin-requests", map[string]any{"token": link.Token}, testOrigin, 409)
	if !strings.Contains(string(raw), "pending_request_cap") {
		t.Fatal(string(raw))
	}
	firstPath := "/api/accounts/signin-requests/" + waiting[0].Request.ID
	_, res := accountRequest(t, p, browsers[0], "POST", firstPath+"/resend", map[string]any{"token": link.Token}, testOrigin, 429)
	if res.Header.Get("Retry-After") == "" {
		t.Fatal("cooldown missing Retry-After")
	}
	p.clock.Advance(10 * time.Second)
	accountRequest(t, p, browsers[0], "POST", firstPath+"/resend", map[string]any{"token": link.Token}, testOrigin, 200)
	accountRequest(t, p, issuer, "POST", base+"/requests/"+waiting[2].Request.ID+"/deny", map[string]any{}, testOrigin, 200)
	accountRequest(t, p, browsers[2], "POST", "/api/accounts/signin-requests", map[string]any{"token": link.Token}, testOrigin, 403)
	ws := connectSignIn(t, p, browsers[0], waiting[0].Request.ID)
	signInEvent(t, ws)
	wrong := ""
	for candidate := 9999; candidate >= 0; candidate-- {
		code := fmt.Sprintf("%04d", candidate)
		found := false
		for _, b := range waiting {
			if b.Code == code {
				found = true
			}
		}
		if !found {
			wrong = code
			break
		}
	}
	if wrong != "9996" {
		t.Fatalf("wrong-code selection = %q, want 9996 after three collisions", wrong)
	}
	for range 5 {
		accountRequest(t, p, issuer, "POST", base+"/approve", map[string]any{"code": wrong}, testOrigin, 403)
	}
	if event := signInEvent(t, ws); event.State != "cancelled" {
		t.Fatalf("fifth rejection rolled back cancellation: %+v", event)
	}
	readClosed(t, ws, realtime.StatusRevoked)
	raw, _ = accountRequest(t, p, issuer, "GET", base, nil, "", 200)
	if !strings.Contains(string(raw), `"state":"revoked"`) {
		t.Fatal("wrong-code budget rolled back")
	}
	raw, _ = accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 200)
	link = decodeSignIn[wireSignInLink](t, raw)
	accountRequest(t, p, issuer, "DELETE", "/api/accounts/signin-links/"+link.Link.ID, nil, testOrigin, 200)
}

func TestDeviceSignInStrictBodies(t *testing.T) {
	p := startPublic(t, 100)
	_, browser := p.browserWithHTTP(t)
	for _, test := range []struct {
		path string
		body any
	}{
		{"/qr-signins", map[string]any{"accountId": "chosen-by-attacker"}},
		{"/qr-signins", map[string]any{"replace": nil}},
		{"/signin-requests", map[string]any{}},
		{"/signin-requests", map[string]any{"token": "x", "unknown": true}},
		{"/signin-requests/id/finish", map[string]any{"token": nil}},
	} {
		accountRequest(t, p, browser, "POST", "/api/accounts"+test.path, test.body, testOrigin, 400)
	}
}

func signInTestServer(t *testing.T, p publicServer, limits *SignInLimits) publicServer {
	t.Helper()
	h := New(Deps{Metrics: http.NotFoundHandler(), Logger: p.events.Logger, Identity: p.identity, Rooms: p.rooms, Voice: p.voice, Lifecycle: p.lifecycle, Live: p.events.Hub, PublicOrigin: testOrigin, SignInNow: p.clock.Now, SignInLimits: limits, AuthLimit: platform.NewLimiter(20, 3*time.Second, p.clock.Now), EnterLimit: platform.NewLimiter(100, time.Hour, p.clock.Now)})
	p.srv = httptest.NewTLSServer(h.Public)
	t.Cleanup(p.srv.Close)
	return p
}

func TestDeviceAnonymousLimitsDoNotConsumePasskeyBudget(t *testing.T) {
	p := signInTestServer(t, startPublic(t, 100), nil)
	_, browser := p.browserWithHTTP(t)
	for range 20 {
		accountRequest(t, p, browser, "POST", "/api/accounts/signin-requests", map[string]any{"token": "invalid"}, testOrigin, 403)
	}
	_, res := accountRequest(t, p, browser, "POST", "/api/accounts/signin-requests", map[string]any{"token": "invalid"}, testOrigin, 429)
	if res.Header.Get("Retry-After") != "3" {
		t.Fatal("link Retry-After missing")
	}
	for range 20 {
		accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{"replace": true}, testOrigin, 403)
	}
	accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 429)
	beginAccount(t, p, browser, "/api/accounts/authentication/begin", map[string]any{})
	accountRequest(t, p, browser, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": "unknown", "proof": "invalid"}, testOrigin, 403)
	p.clock.Advance(3 * time.Second)
	accountRequest(t, p, browser, "POST", "/api/accounts/signin-requests", map[string]any{"token": "invalid"}, testOrigin, 403)
	accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
}

func TestDeviceQRAllocationResumeReplacementAndRefill(t *testing.T) {
	p := signInTestServer(t, startPublic(t, 100), nil)
	_, browser := p.browserWithHTTP(t)
	var begin wireSignInBegin
	for i := range 3 {
		raw, _ := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{"replace": i > 0}, testOrigin, 200)
		begin = decodeSignIn[wireSignInBegin](t, raw)
	}
	for range 4 {
		raw, _ := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
		resume := decodeSignIn[wireSignInBegin](t, raw)
		if resume.Request.ID != begin.Request.ID || resume.Token != begin.Token || !resume.Request.ExpiresAt.Equal(begin.Request.ExpiresAt) {
			t.Fatal("resume allocated or changed deadline")
		}
	}
	_, res := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{"replace": true}, testOrigin, 429)
	if res.Header.Get("Retry-After") != "100" {
		t.Fatal("browser allocation quota missing")
	}
	raw, _ := accountRequest(t, p, browser, "GET", "/api/accounts/signin-requests/"+begin.Request.ID, nil, "", 200)
	if decodeSignIn[wireSignInRequest](t, raw).State != "pending" {
		t.Fatal("quota failure cancelled old request")
	}
	p.clock.Advance(100 * time.Second)
	accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{"replace": true}, testOrigin, 200)
	accountRequest(t, p, browser, "DELETE", "/api/accounts/qr-signins/"+begin.Request.ID, nil, testOrigin, 200)
}

func TestDeviceQRIPAllocationAndPhoneSessionLimits(t *testing.T) {
	p := signInTestServer(t, startPublic(t, 100), nil)
	_, phone := p.browserWithHTTP(t)
	enrollAccount(t, p, phone, "Account", passkeytest.New(t))
	var begin wireSignInBegin
	for range 10 {
		_, b := p.browserWithHTTP(t)
		raw, _ := accountRequest(t, p, b, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
		begin = decodeSignIn[wireSignInBegin](t, raw)
	}
	_, fresh := p.browserWithHTTP(t)
	_, res := accountRequest(t, p, fresh, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 429)
	if res.Header.Get("Retry-After") != "30" {
		t.Fatal("IP allocation quota missing")
	}
	for range 10 {
		accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/preview", map[string]any{"token": begin.Token}, testOrigin, 200)
	}
	_, res = accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/approve", map[string]any{"token": begin.Token}, testOrigin, 429)
	if res.Header.Get("Retry-After") != "6" {
		t.Fatal("shared phone session quota missing")
	}
	p.clock.Advance(6 * time.Second)
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/deny", map[string]any{"token": begin.Token}, testOrigin, 200)
}

func TestDeviceCookieRedeliveryUsesRemainingLifetimeAndBindingSurvivesLogout(t *testing.T) {
	p := signInTestServer(t, startPublic(t, 100), nil)
	_, phone := p.browserWithHTTP(t)
	enrollAccount(t, p, phone, "Account", passkeytest.New(t))
	_, browser := p.browserWithHTTP(t)
	raw, res := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	binding := ""
	for _, c := range res.Cookies {
		if c.Name == signInCookie {
			binding = c.Value
		}
	}
	accountRequest(t, p, phone, "POST", "/api/accounts/qr-signins/approve", map[string]any{"token": begin.Token}, testOrigin, 200)
	path := "/api/accounts/signin-requests/" + begin.Request.ID + "/finish"
	_, res = accountRequest(t, p, browser, "POST", path, map[string]any{}, testOrigin, 200)
	var initial *http.Cookie
	for _, c := range res.Cookies {
		if c.Name == cookieName {
			initial = c
		}
	}
	p.clock.Advance(time.Minute)
	_, res = accountRequest(t, p, browser, "POST", path, map[string]any{}, testOrigin, 200)
	for _, c := range res.Cookies {
		if c.Name == cookieName && (c.Value != initial.Value || c.MaxAge != initial.MaxAge-60) {
			t.Fatal("retry refreshed session lifetime")
		}
	}
	accountRequest(t, p, browser, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	target, _ := url.Parse(p.srv.URL + "/api")
	found := false
	for _, c := range browser.Jar.Cookies(target) {
		if c.Name == signInCookie {
			found = c.Value == binding
		}
	}
	if !found {
		t.Fatal("logout erased independent binding")
	}
}

func TestDeviceApprovalOriginAndAccountAuthorization(t *testing.T) {
	p := startPublic(t, 100)
	_, anonymous := p.browserWithHTTP(t)
	for _, route := range []struct{ method, path string }{
		{"POST", "/signin-links"},
		{"DELETE", "/signin-links/id"},
		{"POST", "/signin-links/id/approve"},
		{"POST", "/signin-links/id/requests/request/deny"},
		{"POST", "/signin-requests"},
		{"POST", "/qr-signins"},
		{"POST", "/qr-signins/preview"},
		{"POST", "/qr-signins/approve"},
		{"POST", "/qr-signins/deny"},
		{"DELETE", "/qr-signins/request"},
		{"POST", "/signin-requests/request/resend"},
		{"POST", "/signin-requests/request/finish"},
	} {
		_, res := accountRequest(t, p, anonymous, route.method, "/api/accounts"+route.path, map[string]any{}, "https://foreign.example", 403)
		if res.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("cacheable account rejection")
		}
	}
	accountRequest(t, p, anonymous, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 401)
	guest, browser := p.browserWithHTTP(t)
	p.enter(t, guest, "Guest")
	accountRequest(t, p, browser, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 401)
	accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins/preview", map[string]any{"token": "unknown"}, testOrigin, 401)
}
