package httpapi

import (
	"bytes"
	"cmp"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

// webhook posts event to the internal listener's LiveKit webhook, signed
// with secret, or unsigned when secret is empty, and returns the response
// status and body.
func (p publicServer) webhook(t *testing.T, event *livekit.WebhookEvent, secret string) (int, []byte) {
	t.Helper()
	body, authorization, err := voicetest.Sign(event, testLiveKitKey, cmp.Or(secret, testLiveKitSecret))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, p.internal.URL+"/livekit/webhook", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/webhook+json")
	if secret != "" {
		req.Header.Set("Authorization", authorization)
	}
	res, err := p.internal.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /livekit/webhook: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	got, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return res.StatusCode, got
}

// applied posts event signed as LiveKit signs it and fails the test unless
// the server applies it.
func (p publicServer) applied(t *testing.T, event *livekit.WebhookEvent) {
	t.Helper()
	if status, body := p.webhook(t, event, testLiveKitSecret); status != http.StatusNoContent {
		t.Fatalf("POST /livekit/webhook %s = %d %s, want 204", event.GetEvent(), status, body)
	}
}

// occupancy returns the occupancy of the room roomID as b lists it.
func occupancy(t *testing.T, b *api.ClientWithResponses, roomID string) []api.Participant {
	t.Helper()
	res, err := b.ListRoomsWithResponse(t.Context())
	if err != nil {
		t.Fatalf("ListRooms: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil {
		t.Fatalf("ListRooms = %d %s, want 200", res.StatusCode(), res.Body)
	}
	for _, r := range res.JSON200.Rooms {
		if r.Id == roomID {
			return r.Occupancy
		}
	}
	t.Fatalf("ListRooms = %s, want room %s in it", res.Body, roomID)
	return nil
}

// nextOccupancy reads the next event from the connection and fails the test
// unless it is occupancy.changed.
func nextOccupancy(t *testing.T, next func() api.Event) api.OccupancyChange {
	t.Helper()
	e := next()
	if e.Type != api.EventTypeOccupancyChanged || e.RoomId != "" {
		t.Fatalf("event = %+v, want occupancy.changed without a roomId", e)
	}
	change, err := e.Payload.AsOccupancyChange()
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	return change
}

func TestSignedWebhooksKeepTheOccupancyListedAndSentLive(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	bob := p.enter(t, b, "Bob")
	watcher, watcherHTTP := p.browserWithHTTP(t)
	p.enter(t, watcher, "Ann")
	ws := p.connectLive(t, watcherHTTP)
	next := func() api.Event { return nextEvent(t, ws) }

	creds := joinedVoice(t, b, lounge.ID)
	inVoice := p.livekit.AddParticipant(lounge.ID, creds.GrantId)
	p.applied(t, voicetest.Joined(inVoice))
	want := []api.Participant{{VisitorId: bob.Id, Name: "Bob"}}
	if got := nextOccupancy(t, next); got.RoomId != lounge.ID || !slices.Equal(got.Occupancy, want) {
		t.Errorf("occupancy.changed = %+v, want Bob in the lounge", got)
	}
	if got := occupancy(t, watcher, lounge.ID); !slices.Equal(got, want) {
		t.Errorf("lounge occupancy = %+v, want %+v", got, want)
	}

	p.applied(t, voicetest.Left(inVoice))
	if got := nextOccupancy(t, next); got.RoomId != lounge.ID || len(got.Occupancy) != 0 {
		t.Errorf("occupancy.changed = %+v, want the lounge empty", got)
	}
	if got := occupancy(t, watcher, lounge.ID); len(got) != 0 {
		t.Errorf("lounge occupancy = %+v, want none", got)
	}
}

func TestWebhooksNotSignedWithTheLiveKitKeyAreRefused(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	p.enter(t, b, "Bob")
	creds := joinedVoice(t, b, lounge.ID)
	joined := voicetest.Joined(p.livekit.AddParticipant(lounge.ID, creds.GrantId))

	for name, secret := range map[string]string{"unsigned": "", "wrong secret": "another-secret-of-at-least-32-characters"} {
		status, body := p.webhook(t, joined, secret)
		wantError(t, "POST /livekit/webhook "+name, status, body, http.StatusUnauthorized, "webhook_unverified")
	}
	if got := occupancy(t, b, lounge.ID); len(got) != 0 {
		t.Errorf("lounge occupancy = %+v, want none", got)
	}
}

func TestTheWebhookIsNotServedOnThePublicListener(t *testing.T) {
	p := startPublic(t, 10)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, p.srv.URL+"/livekit/webhook", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/webhook+json")
	res, err := p.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	wantError(t, "public POST /livekit/webhook", res.StatusCode, body, http.StatusNotFound, "not_found")
}

func TestAParticipantWhoMayNotStayIsRemovedAndNotListed(t *testing.T) {
	p := startPublic(t, 1000)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	p.enter(t, b, "Bob")
	creds := joinedVoice(t, b, lounge.ID)

	// Bob never connects live updates, so once his reservation lapses
	// another visitor enters under his name and connects.
	p.clock.Advance(time.Minute)
	other, otherHTTP := p.browserWithHTTP(t)
	p.enter(t, other, "bob")
	p.connectLive(t, otherHTTP)
	taken := p.livekit.AddParticipant(lounge.ID, creds.GrantId)
	p.applied(t, voicetest.Joined(taken))
	unknown := p.livekit.AddParticipant(lounge.ID, "01JBX6ZZZZZZZZZZZZZZZZZZZZ")
	p.applied(t, voicetest.Joined(unknown))

	if got, want := p.livekit.Removed(), []voice.Participant{taken, unknown}; !slices.Equal(got, want) {
		t.Errorf("removed %+v, want %+v", got, want)
	}
	if got := occupancy(t, b, lounge.ID); len(got) != 0 {
		t.Errorf("lounge occupancy = %+v, want none", got)
	}
}

func TestAParticipantStaysWhileAnotherVisitorOnlyReservesTheirNameAndIsRemovedOnceTheyConnect(t *testing.T) {
	p := startPublic(t, 1000)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	bob := p.enter(t, b, "Bob")
	creds := joinedVoice(t, b, lounge.ID)

	// Bob never connects live updates, so once his reservation lapses
	// another visitor enters under his name, but does not connect yet.
	p.clock.Advance(time.Minute)
	other, otherHTTP := p.browserWithHTTP(t)
	p.enter(t, other, "bob")
	inVoice := p.livekit.AddParticipant(lounge.ID, creds.GrantId)
	p.applied(t, voicetest.Joined(inVoice))
	if err := p.voice.Refresh(t.Context()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if got := p.livekit.Removed(); len(got) != 0 {
		t.Errorf("removed %+v while bob is only reserved, want no one", got)
	}
	if got, want := occupancy(t, b, lounge.ID), []api.Participant{{VisitorId: bob.Id, Name: "Bob"}}; !slices.Equal(got, want) {
		t.Errorf("lounge occupancy = %+v, want %+v", got, want)
	}

	p.connectLive(t, otherHTTP)
	if err := p.voice.Refresh(t.Context()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if got := p.livekit.Removed(); !slices.Equal(got, []voice.Participant{inVoice}) {
		t.Errorf("removed %+v once the other bob connected, want %+v", got, inVoice)
	}
	if got := occupancy(t, b, lounge.ID); len(got) != 0 {
		t.Errorf("lounge occupancy = %+v, want none", got)
	}
}
