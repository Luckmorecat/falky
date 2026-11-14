package httpapi

import (
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/platform"
)

func TestDeviceAnonymousCompletionTrafficDoesNotConsumePasskeyBudget(t *testing.T) {
	for _, operation := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/accounts/signin-requests/unknown/finish", map[string]any{}},
		{"POST", "/api/accounts/signin-requests/unknown/resend", map[string]any{"token": "invalid"}},
		{"DELETE", "/api/accounts/qr-signins/unknown", nil},
	} {
		t.Run(operation.path, func(t *testing.T) {
			p := signInTestServer(t, startPublic(t, 100), nil)
			_, browser := p.browserWithHTTP(t)
			for range 20 {
				accountRequest(t, p, browser, operation.method, operation.path, operation.body, testOrigin, 403)
			}
			accountRequest(t, p, browser, operation.method, operation.path, operation.body, testOrigin, 429)
			beginAccount(t, p, browser, "/api/accounts/authentication/begin", map[string]any{})
			accountRequest(t, p, browser, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": "unknown", "proof": "invalid"}, testOrigin, 403)
		})
	}
}

func TestDeviceQRInjectedLimitsReturnActualWaitAndDoNotChargeRejectedAllocation(t *testing.T) {
	p := startPublic(t, 100)
	p = signInTestServer(t, p, &SignInLimits{
		QRBrowserAllocations: platform.NewLimiter(1, 7*time.Second, p.clock.Now),
		QRIPAllocations:      platform.NewLimiter(1, 11*time.Second, p.clock.Now),
	})
	_, browser := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	first := decodeSignIn[wireSignInBegin](t, raw)
	p.clock.Advance(7 * time.Second)
	_, res := accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{"replace": true}, testOrigin, 429)
	if wait := res.Header.Get("Retry-After"); wait != "4" {
		t.Fatalf("remaining IP retry=%q, want 4", wait)
	}
	raw, _ = accountRequest(t, p, browser, "GET", "/api/accounts/signin-requests/"+first.Request.ID, nil, "", 200)
	if state := decodeSignIn[wireSignInRequest](t, raw); state.State != "pending" || !state.ExpiresAt.Equal(first.Request.ExpiresAt) {
		t.Fatal("rejected allocation changed the old request")
	}
	p.clock.Advance(4 * time.Second)
	raw, _ = accountRequest(t, p, browser, "POST", "/api/accounts/qr-signins", map[string]any{"replace": true}, testOrigin, 200)
	if replacement := decodeSignIn[wireSignInBegin](t, raw); replacement.Request.ID == first.Request.ID {
		t.Fatal("replacement failed")
	}
}

func TestDeviceLinkCreationDoesNotSetCookie(t *testing.T) {
	p := startPublic(t, 100)
	_, issuer := p.browserWithHTTP(t)
	enrollAccount(t, p, issuer, "Account", passkeytest.New(t))
	_, res := accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 200)
	if _, exists := res.Header["Set-Cookie"]; exists {
		t.Fatal("link creation emitted an empty cookie header")
	}
}

func TestDeviceRepeatedResendHintsPreserveVersionAndSingleRedemption(t *testing.T) {
	p := startPublicLimited(t, 100, 1000)
	_, issuer := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, issuer, "Account", key)
	_, peer := loginAccountBrowser(t, p, key)
	issuerLive, peerLive := p.connectLive(t, issuer), p.connectLive(t, peer)
	raw, _ := accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 200)
	link := decodeSignIn[wireSignInLink](t, raw)
	_, candidate := p.browserWithHTTP(t)
	raw, _ = accountRequest(t, p, candidate, "POST", "/api/accounts/signin-requests", map[string]any{"token": link.Token}, testOrigin, 200)
	begin := decodeSignIn[wireSignInBegin](t, raw)
	initial := signInEvent(t, issuerLive)
	candidateLive := connectSignIn(t, p, candidate, begin.Request.ID)
	signInEvent(t, candidateLive)
	path := "/api/accounts/signin-requests/" + begin.Request.ID
	for range 2 {
		p.clock.Advance(10 * time.Second)
		accountRequest(t, p, candidate, "POST", path+"/resend", map[string]any{"token": link.Token}, testOrigin, 200)
		for _, hint := range []wireSignInRequest{signInEvent(t, issuerLive), signInEvent(t, candidateLive)} {
			if hint != initial {
				t.Fatalf("duplicate hint changed durable state: got %+v want %+v", hint, initial)
			}
		}
	}
	p.createRoom(t, "Privacy barrier")
	if event := nextEvent(t, peerLive); string(event.Type) != "room.changed" {
		t.Fatalf("peer received private hint: %s", event.Type)
	}
	accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links/"+link.Link.ID+"/approve", map[string]any{"code": begin.Code}, testOrigin, 200)
	if hint := signInEvent(t, candidateLive); hint.State != "approved" || hint.Version != initial.Version+1 {
		t.Fatalf("approval after duplicate hints: %+v", hint)
	}
	token := ""
	for range 2 {
		_, res := accountRequest(t, p, candidate, "POST", path+"/finish", map[string]any{"token": link.Token}, testOrigin, 200)
		delivered := ""
		for _, cookie := range res.Cookies {
			if cookie.Name == cookieName {
				delivered = cookie.Value
			}
		}
		if delivered == "" || token != "" && delivered != token {
			t.Fatal("duplicate hint led to another session")
		}
		token = delivered
	}
	var events int
	if err := p.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM session_authentications WHERE device_approval_request_id=?", begin.Request.ID).Scan(&events); err != nil || events != 1 {
		t.Fatalf("authentication events=%d: %v", events, err)
	}
	if strings.Contains(p.logs.String(), token) {
		t.Fatal("delivery secret leaked")
	}
}
