package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"

	"github.com/coder/websocket"
	"github.com/kisshot/falky/server/internal/api"
)

func TestColourSaveIsConfirmedAndBroadcastToOtherVisitorsAndAllOwnTabs(t *testing.T) {
	p := startPublic(t, 10)
	bob, bh := p.browserWithHTTP(t)
	ann, ah := p.browserWithHTTP(t)
	bv := p.enter(t, bob, "Bob")
	av := p.enter(t, ann, "Ann")
	b1 := p.connectLive(t, bh)
	b2 := p.connectLive(t, bh)
	a := p.connectLive(t, ah)
	saved, err := bob.SetMyColourWithResponse(t.Context(), api.ColourRequest{Palette: av.Colour.Palette})
	if err != nil {
		t.Fatal(err)
	}
	if saved.JSON200 == nil || saved.JSON200.VisitorId != bv.Id || saved.JSON200.Palette != av.Colour.Palette || saved.JSON200.Revision != 2 {
		t.Fatalf("save = %d %s", saved.StatusCode(), saved.Body)
	}
	for _, ws := range []*websocket.Conn{b1, b2, a} {
		event := nextEvent(t, ws)
		colour, err := event.Payload.AsVisitorColour()
		if err != nil || event.Type != api.EventTypeVisitorColourChanged || colour != *saved.JSON200 || event.RoomId != "" {
			t.Fatalf("colour event = %+v, %v", event, err)
		}
	}
	me, err := ann.GetMeWithResponse(t.Context())
	if err != nil || me.JSON200 == nil || me.JSON200.Colour != av.Colour {
		t.Fatalf("another visitor changed: %+v %v", me, err)
	}
	invalid, err := bob.SetMyColourWithResponse(t.Context(), api.ColourRequest{Palette: "invalid"})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "invalid colour", invalid.StatusCode(), invalid.Body, http.StatusBadRequest, "invalid_palette")
	snapshot, err := bob.LookupVisitorColoursWithResponse(t.Context(), api.VisitorColourLookup{VisitorIds: []string{bv.Id, av.Id, bv.Id, "unknown"}})
	if err != nil || snapshot.JSON200 == nil || len(snapshot.JSON200.Colours) != 2 || snapshot.JSON200.Colours[0] != *saved.JSON200 || snapshot.JSON200.Colours[1] != av.Colour {
		t.Fatalf("snapshot = %+v %v", snapshot, err)
	}
}

func TestColourEndpointsRequireAuthenticationAndBoundExplicitLookups(t *testing.T) {
	p := startPublic(t, 10)
	unauth := p.browser(t)
	save, err := unauth.SetMyColourWithResponse(t.Context(), api.ColourRequest{Palette: api.PaletteNameSky})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "unauthenticated save", save.StatusCode(), save.Body, http.StatusUnauthorized, "visitor_required")
	lookup, err := unauth.LookupVisitorColoursWithResponse(t.Context(), api.VisitorColourLookup{VisitorIds: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "unauthenticated lookup", lookup.StatusCode(), lookup.Body, http.StatusUnauthorized, "visitor_required")
	bob := p.browser(t)
	bv := p.enter(t, bob, "Bob")
	for _, ids := range [][]string{nil, make([]string, 101)} {
		got, err := bob.LookupVisitorColoursWithResponse(t.Context(), api.VisitorColourLookup{VisitorIds: ids})
		if err != nil {
			t.Fatal(err)
		}
		wantError(t, "invalid lookup", got.StatusCode(), got.Body, http.StatusBadRequest, "invalid_request")
	}
	empty, err := bob.LookupVisitorColoursWithResponse(t.Context(), api.VisitorColourLookup{VisitorIds: []string{}})
	if err != nil || empty.JSON200 == nil || len(empty.JSON200.Colours) != 0 || !strings.Contains(string(empty.Body), `"colours":[]`) {
		t.Fatalf("empty lookup = %+v, %v", empty, err)
	}
	ids := make([]string, 100)
	for n := range ids {
		ids[n] = bv.Id
	}
	max, err := bob.LookupVisitorColoursWithResponse(t.Context(), api.VisitorColourLookup{VisitorIds: ids})
	if err != nil || max.JSON200 == nil || len(max.JSON200.Colours) != 1 {
		t.Fatalf("bounded lookup = %+v, %v", max, err)
	}
}

func TestColourSaveCannotTargetAnotherVisitorAndHistoricalRecoveryKeepsAccessRevoked(t *testing.T) {
	p := startPublic(t, 10)
	bob := p.browser(t)
	bv := p.enter(t, bob, "Bob")
	ann := p.browser(t)
	av := p.enter(t, ann, "Ann")
	save, err := bob.SetMyColourWithBodyWithResponse(t.Context(), "application/json", strings.NewReader(`{"palette":"ruby","visitorId":"`+av.Id+`"}`))
	if err != nil || save.JSON200 == nil || save.JSON200.VisitorId != bv.Id {
		t.Fatalf("self-only save = %+v, %v", save, err)
	}
	if got := me(t, ann); got.Colour != av.Colour {
		t.Fatalf("targeted another visitor: %+v", got)
	}
	link, err := p.identity.Rotate(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	p.secret = strings.TrimPrefix(link, testOrigin+"/#k=")
	fresh := p.browser(t)
	p.enter(t, fresh, "Fresh")
	historical, err := fresh.LookupVisitorColoursWithResponse(t.Context(), api.VisitorColourLookup{VisitorIds: []string{bv.Id, av.Id}})
	if err != nil || historical.JSON200 == nil || len(historical.JSON200.Colours) != 2 || historical.JSON200.Colours[0] != *save.JSON200 {
		t.Fatalf("historical recovery = %+v, %v", historical, err)
	}
	revoked, err := bob.GetMeWithResponse(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "historical identity stays revoked", revoked.StatusCode(), revoked.Body, http.StatusUnauthorized, "visitor_required")
}

func TestAllocationCountsActualConnectedVisitorsOnceAcrossTabsAndFailedUpgrades(t *testing.T) {
	var candidateCount atomic.Int64
	p := startPublicLimited(t, 1000, 1000, identity.WithColourChoice(func(n int) int { candidateCount.Store(int64(n)); return 0 }))
	var clients []*api.ClientWithResponses
	var firstHTTP *http.Client
	for n := range 16 {
		b, hc := p.browserWithHTTP(t)
		v := p.enter(t, b, fmt.Sprintf("Visitor %d", n))
		clients = append(clients, b)
		if n == 0 {
			firstHTTP = hc
			continue
		}
		ws := p.connectLive(t, hc)
		// Receiving this event proves the upgrade is registered as open.
		if _, err := b.SetMyColourWithResponse(t.Context(), api.ColourRequest{Palette: v.Colour.Palette}); err != nil {
			t.Fatal(err)
		}
		nextEvent(t, ws)
	}
	// A request accepted by identity.Connect but refused by websocket.Accept
	// must leave sky eligible for reuse (pending name reservations do not count).
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.srv.URL+"/api/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	failed, err := firstHTTP.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = failed.Body.Close()
	if failed.StatusCode != http.StatusBadRequest {
		t.Fatalf("failed upgrade = %d", failed.StatusCode)
	}
	offline := p.enter(t, p.browser(t), "Offline reuse")
	if offline.Colour.Palette != api.PaletteNameSky || candidateCount.Load() != 1 {
		t.Fatalf("failed upgrade counted as connected: %+v", offline.Colour)
	}
	first := p.connectLive(t, firstHTTP)
	second := p.connectLive(t, firstHTTP)
	current := me(t, clients[0])
	if _, err := clients[0].SetMyColourWithResponse(t.Context(), api.ColourRequest{Palette: current.Colour.Palette}); err != nil {
		t.Fatal(err)
	}
	nextEvent(t, first)
	nextEvent(t, second)
	// All sixteen palettes have one connected visitor. Two tabs must not make
	// sky more used than the rest; deterministic sampling picks the first tie.
	tied := p.enter(t, p.browser(t), "All connected")
	if tied.Colour.Palette != api.PaletteNameSky || candidateCount.Load() != 16 {
		t.Fatalf("tabs weighted visitor twice: %+v", tied.Colour)
	}
	closeLive(t, first)
	remaining := p.enter(t, p.browser(t), "One tab remains")
	if remaining.Colour.Palette != api.PaletteNameSky || candidateCount.Load() != 16 {
		t.Fatalf("closing one tab lost membership: %+v", remaining.Colour)
	}
	closeLive(t, second)
	reused := p.enterOnceFree(t, p.browser(t), "Visitor 0")
	if reused.Colour.Palette != api.PaletteNameSky || candidateCount.Load() != 1 {
		t.Fatalf("last close did not free connected palette: %+v", reused.Colour)
	}
	confirmed := me(t, clients[0]).Colour
	returning := p.connectLive(t, firstHTTP)
	if got := me(t, clients[0]).Colour; got != confirmed {
		t.Fatalf("reconnect rerolled: %+v, want %+v", got, confirmed)
	}
	closeLive(t, returning)
}
