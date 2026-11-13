package httpapi

import (
	"net/http/httptest"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestSignInClientIPUsesLastProxyEntry(t *testing.T) {
	r := httptest.NewRequest("POST", "/", nil)
	r.RemoteAddr = "192.0.2.1:1234"
	if signInClientIP(r) != "" {
		t.Fatal("proxy address must not be displayed as client IP")
	}
	r.Header.Add("X-Forwarded-For", "198.51.100.1")
	r.Header.Add("X-Forwarded-For", "203.0.113.9, 2001:db8::42")
	if got := signInClientIP(r); got != "2001:db8::42" {
		t.Fatalf("IP=%q", got)
	}
	wire := signInRequestBody(identity.SignInRequestView{RequesterIP: "2001:db8::42"})
	if wire.RequesterIp != "2001:db8::42" {
		t.Fatal("IP missing from API response")
	}
}
