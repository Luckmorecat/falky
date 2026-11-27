package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestSignInApproverLocation(t *testing.T) {
	var calls atomic.Int32
	geo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var query struct{ IP string }
		if r.Method != http.MethodPost || r.URL.Path != "/v1/lookup" || r.Header.Get("Content-Type") != "application/json" || json.NewDecoder(r.Body).Decode(&query) != nil {
			t.Error("unexpected GeoIP request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls.Add(1)
		var result string
		switch query.IP {
		case "8.8.8.8":
			time.Sleep(30 * time.Millisecond)
			result = `{"countryCode":"UA","city":"Kyiv"}`
		case "2606:4700::1":
			result = `{"countryCode":"US","city":null}`
		case "1.1.1.1":
			result = `{"countryCode":null,"city":"Example City"}`
		case "203.0.113.42":
			result = `{"countryCode":null,"city":null}`
		case "9.9.9.9":
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		case "8.8.4.4":
			select {
			case <-r.Context().Done():
				return
			case <-time.After(2 * time.Second):
				t.Error("GeoIP lookup was not cancelled")
			}
		default:
			t.Errorf("unexpected GeoIP lookup for %q", query.IP)
		}
		if _, err := io.WriteString(w, result); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(geo.Close)

	p := startPublic(t, 100)
	p.srv = httptest.NewTLSServer(New(Deps{
		Metrics: http.NotFoundHandler(), Logger: p.events.Logger, Identity: p.identity, SignInNow: p.clock.Now,
		Lifecycle: p.lifecycle, Live: p.events.Hub, PublicOrigin: testOrigin, GeoIPURL: geo.URL,
	}).Public)
	t.Cleanup(p.srv.Close)
	_, approver := p.browserWithHTTP(t)
	enrollAccount(t, p, approver, "Approver", passkeytest.New(t))
	_, other := p.browserWithHTTP(t)
	enrollAccount(t, p, other, "Other", passkeytest.New(t))

	raw, _ := accountRequest(t, p, approver, http.MethodPost, "/api/accounts/signin-links", map[string]any{}, testOrigin, http.StatusOK)
	link := decodeSignIn[api.SignInLinkResult](t, raw)
	begin, _, err := p.identity.BeginSignInRequest(t.Context(), link.Token, "", "", "Browser", "8.8.8.8")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.identity.BeginSignInRequest(t.Context(), link.Token, "", "", "Same network", "8.8.8.8"); err != nil {
		t.Fatal(err)
	}
	_, candidate := p.browserWithHTTP(t)
	requestURL, err := url.Parse(p.srv.URL + "/api/accounts/signin-requests/" + begin.Request.ID)
	if err != nil {
		t.Fatal(err)
	}
	candidate.Jar.SetCookies(requestURL, []*http.Cookie{{Name: signInCookie, Value: begin.BrowserSecret, Path: "/", Secure: true}})
	raw, _ = accountRequest(t, p, candidate, http.MethodGet, requestURL.Path, nil, "", http.StatusOK)
	if strings.Contains(string(raw), `"requesterLocation"`) {
		t.Fatalf("candidate location = %s", raw)
	}
	linkPath := "/api/accounts/signin-links/" + link.Link.Id
	accountRequest(t, p, other, http.MethodGet, linkPath, nil, "", http.StatusForbidden)
	if calls.Load() != 0 {
		t.Fatal("lookup ran before the issuer reviewed the link")
	}
	for range 2 {
		raw, _ = accountRequest(t, p, approver, http.MethodGet, linkPath, nil, "", http.StatusOK)
		requests := decodeSignIn[api.SignInLink](t, raw).Requests
		want := api.SignInLocation{CountryCode: "UA", City: "Kyiv"}
		if len(requests) != 2 {
			t.Fatalf("issuer link = %s", raw)
		}
		for _, request := range requests {
			if request.RequesterIp != "8.8.8.8" || request.RequesterLocation == nil || *request.RequesterLocation != want {
				t.Fatalf("issuer link = %s", raw)
			}
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("repeated issuer reads for two requests sharing an IP made %d lookups", calls.Load())
	}

	for _, tc := range []struct {
		name string
		ip   string
		want *api.SignInLocation
	}{
		{"country only", "2606:4700::1", &api.SignInLocation{CountryCode: "US"}},
		{"city only", "1.1.1.1", &api.SignInLocation{City: "Example City"}},
		{"no match", "203.0.113.42", nil},
		{"service unavailable", "9.9.9.9", nil},
		{"timeout", "8.8.4.4", nil},
		{"private IP", "192.168.1.2", nil},
		{"no IP", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p.clock.Advance(12 * time.Second)
			start, _, err := p.identity.BeginQRSignIn(t.Context(), "", "", "Browser", false, nil, tc.ip)
			if err != nil {
				t.Fatal(err)
			}
			body := map[string]any{"token": start.QRToken}
			count := calls.Load()
			raw, _ := accountRequest(t, p, approver, http.MethodPost, "/api/accounts/qr-signins/preview", body, testOrigin, http.StatusOK)
			preview := decodeSignIn[api.SignInPreview](t, raw).Request
			got := preview.RequesterLocation
			if preview.RequesterIp != tc.ip || (got == nil) != (tc.want == nil) || got != nil && *got != *tc.want {
				t.Fatalf("QR preview = %s", raw)
			}
			if (tc.name == "private IP" || tc.ip == "") && calls.Load() != count {
				t.Fatal("looked up an unavailable or private address")
			}
			accountRequest(t, p, approver, http.MethodPost, "/api/accounts/qr-signins/deny", body, testOrigin, http.StatusOK)
		})
	}
}
