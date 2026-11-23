package geoip

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestSharedLookupSurvivesFirstCallerLeaving(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	respond := make(chan struct{})
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-respond:
			if _, err := io.WriteString(w, `{"countryCode":"UA","city":"Kyiv"}`); err != nil {
				t.Error(err)
			}
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(service.Close)
	client := New(service.URL)
	firstCtx, cancel := context.WithCancel(t.Context())
	first := make(chan Location, 1)
	go func() { first <- client.Lookup(firstCtx, "8.8.8.8") }()
	select {
	case <-started:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("GeoIP request did not start")
	}
	cancel()
	close(respond)
	want := Location{CountryCode: "UA", City: "Kyiv"}
	if got := client.Lookup(t.Context(), "8.8.8.8"); got != want {
		t.Fatalf("review still open got %+v, want %+v", got, want)
	}
	if got := <-first; got != want || calls.Load() != 1 {
		t.Fatalf("shared result %+v after %d lookups", got, calls.Load())
	}
}
