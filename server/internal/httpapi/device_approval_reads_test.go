package httpapi

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestDeviceReadOnlyHandlersDoNotWaitForLifecycleGate(t *testing.T) {
	p := startPublic(t, 100)
	_, issuer := p.browserWithHTTP(t)
	enrollAccount(t, p, issuer, "Account", passkeytest.New(t))
	raw, _ := accountRequest(t, p, issuer, "POST", "/api/accounts/signin-links", map[string]any{}, testOrigin, 200)
	link := decodeSignIn[wireSignInLink](t, raw)
	_, candidate := p.browserWithHTTP(t)
	raw, _ = accountRequest(t, p, candidate, "POST", "/api/accounts/qr-signins", map[string]any{}, testOrigin, 200)
	qr := decodeSignIn[wireSignInBegin](t, raw)
	p.lifecycle.Lock()
	defer p.lifecycle.Unlock()
	for _, read := range []struct {
		method, path, body string
		browser            *http.Client
	}{
		{"GET", "/api/accounts/signin-links/" + link.Link.ID, "", issuer},
		{"GET", "/api/accounts/signin-requests/" + qr.Request.ID, "", candidate},
		{"POST", "/api/accounts/qr-signins/preview", `{"token":"` + qr.Token + `"}`, issuer},
	} {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		req, err := http.NewRequestWithContext(ctx, read.method, p.srv.URL+read.path, strings.NewReader(read.body))
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", testOrigin)
		res, err := read.browser.Do(req)
		if err != nil {
			cancel()
			t.Fatalf("%s waited for lifecycle: %v", read.path, err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		cancel()
		if res.StatusCode != 200 {
			t.Fatalf("%s returned %d", read.path, res.StatusCode)
		}
	}
}
