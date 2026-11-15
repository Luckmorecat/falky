package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kisshot/falky/server/internal/api"
)

func knock(t *testing.T, b *api.ClientWithResponses, roomID, visitorID string) *api.KnockResponse {
	t.Helper()
	res, err := b.KnockWithResponse(t.Context(), roomID, api.KnockJSONRequestBody{VisitorId: visitorID})
	if err != nil {
		t.Fatalf("Knock: %v", err)
	}
	return res
}

// wantSilence fails the test if ws receives an event within a short while.
func wantSilence(t *testing.T, ws *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	if _, data, err := ws.Read(ctx); err == nil {
		t.Errorf("got event %s, want none", data)
	}
}

func TestAKnockReachesOnlyTheKnockedIdentity(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	alex := p.browser(t)
	p.inVoice(t, alex, p.enter(t, alex, "Alex"), lounge.ID)
	bob, bobHTTP := p.browserWithHTTP(t)
	bobVisitor := p.enter(t, bob, "Bob")
	bobLive := p.connectLive(t, bobHTTP)
	ann, annHTTP := p.browserWithHTTP(t)
	p.enter(t, ann, "Ann")
	annLive := p.connectLive(t, annHTTP)

	if res := knock(t, alex, lounge.ID, bobVisitor.Id); res.StatusCode() != http.StatusNoContent {
		t.Fatalf("Knock = %d %s, want 204", res.StatusCode(), res.Body)
	}
	e := nextEvent(t, bobLive)
	if e.Type != api.EventTypeKnock || e.RoomId != lounge.ID {
		t.Fatalf("Bob got %s in room %q, want knock in the lounge", e.Type, e.RoomId)
	}
	got, err := e.Payload.AsKnock()
	if err != nil {
		t.Fatalf("knock payload: %v", err)
	}
	if got.RoomId != lounge.ID || got.From.Name != "Alex" || got.From.VisitorId == "" {
		t.Errorf("knock = %+v, want Alex calling into the lounge", got)
	}
	wantSilence(t, annLive)
}

func TestKnockingAnswersTheSameWhoeverIsKnocked(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	alex := p.browser(t)
	p.inVoice(t, alex, p.enter(t, alex, "Alex"), lounge.ID)
	sam, samHTTP := p.browserWithHTTP(t)
	samVisitor := p.enter(t, sam, "Sam")
	p.inVoice(t, sam, samVisitor, lounge.ID)
	samLive := p.connectLive(t, samHTTP)

	for name, id := range map[string]string{"unknown": "01JBX6Z8Q3M5W2K7R9T4V1C0DE", "already in this voice": samVisitor.Id} {
		if res := knock(t, alex, lounge.ID, id); res.StatusCode() != http.StatusNoContent {
			t.Errorf("Knock %s = %d %s, want 204", name, res.StatusCode(), res.Body)
		}
	}
	wantSilence(t, samLive)
}

func TestKnockingIsRefusedOutsideTheVoiceForYourselfAndTooOften(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	alex := p.browser(t)
	alexVisitor := p.enter(t, alex, "Alex")
	bob := p.browser(t)
	bobVisitor := p.enter(t, bob, "Bob")

	res := knock(t, alex, lounge.ID, bobVisitor.Id)
	wantError(t, "Knock outside the voice", res.StatusCode(), res.Body, http.StatusConflict, "not_in_voice")

	p.inVoice(t, alex, alexVisitor, lounge.ID)
	res = knock(t, alex, lounge.ID, alexVisitor.Id)
	wantError(t, "Knock yourself", res.StatusCode(), res.Body, http.StatusBadRequest, "invalid_request")
	res = knock(t, alex, "01JBX6Z8Q3M5W2K7R9T4V1C0DF", bobVisitor.Id)
	wantError(t, "Knock in an unknown room", res.StatusCode(), res.Body, http.StatusNotFound, "room_not_found")

	if res := knock(t, alex, lounge.ID, bobVisitor.Id); res.StatusCode() != http.StatusNoContent {
		t.Fatalf("first Knock = %d %s, want 204", res.StatusCode(), res.Body)
	}
	res = knock(t, alex, lounge.ID, bobVisitor.Id)
	wantError(t, "second Knock right away", res.StatusCode(), res.Body, http.StatusTooManyRequests, "knock_too_soon")
	if after := res.HTTPResponse.Header.Get("Retry-After"); after == "" || after == "0" {
		t.Errorf("Retry-After = %q, want whole seconds until the next knock", after)
	}
}

func TestACallerCanKnockOnlyAFewPeopleInAMinute(t *testing.T) {
	limits := newKnockLimits(time.Now)
	for i := range knockCallerBurst {
		if wait := limits.caller.Take("alex"); wait > 0 {
			t.Fatalf("knock %d waits %v, want it allowed", i+1, wait)
		}
	}
	if wait := limits.caller.Take("alex"); wait <= 0 {
		t.Errorf("knock %d allowed, want it refused", knockCallerBurst+1)
	}
}
