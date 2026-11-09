package httpapi

import (
	"context"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

// adminClient serves the admin socket over p's services and returns its
// client.
func (p publicServer) adminClient(t *testing.T) *admin.Client {
	t.Helper()
	path := filepath.Join(t.TempDir(), "admin.sock")
	ln, err := admin.Listen(t.Context(), path)
	if err != nil {
		t.Fatalf("admin.Listen: %v", err)
	}
	srv := &http.Server{
		Handler: admin.Handler(admin.Deps{
			Logger: p.events.Logger, Identity: p.identity, Rooms: p.rooms, Lifecycle: p.lifecycle,
		}),
		ReadHeaderTimeout: time.Second,
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return admin.NewClient(path)
}

// inVoice joins b, the visitor v, to the voice of the room roomID and makes
// them a participant there, as LiveKit reports it.
func (p publicServer) inVoice(t *testing.T, b *api.ClientWithResponses, v api.Visitor, roomID string) voice.Participant {
	t.Helper()
	joinedVoice(t, b, roomID)
	participant := p.livekit.AddParticipant(roomID, v.Id)
	p.applied(t, voicetest.Joined(participant))
	return participant
}

func TestRotatingTheLinkEndsEveryAccessOfTheOldOneWithinTwoSeconds(t *testing.T) {
	p := startPublic(t, 10)
	lounge, games := p.createRoom(t, "Lounge"), p.createRoom(t, "Games")
	bob, bobHTTP := p.browserWithHTTP(t)
	bobVisitor := p.enter(t, bob, "Bob")
	ann, annHTTP := p.browserWithHTTP(t)
	annVisitor := p.enter(t, ann, "Ann")
	sockets := []*websocket.Conn{p.connectLive(t, bobHTTP), p.connectLive(t, annHTTP)}
	inVoice := []voice.Participant{p.inVoice(t, bob, bobVisitor, lounge.ID), p.inVoice(t, ann, annVisitor, games.ID)}
	for _, ws := range sockets {
		nextOccupancy(t, func() api.Event { return nextEvent(t, ws) })
		nextOccupancy(t, func() api.Event { return nextEvent(t, ws) })
	}
	oldSecret := p.secret

	start := time.Now()
	link, err := p.adminClient(t).RotateLink(t.Context())
	if err != nil {
		t.Fatalf("RotateLink: %v", err)
	}
	ctx, cancel := context.WithDeadline(t.Context(), start.Add(2*time.Second))
	defer cancel()
	for _, ws := range sockets {
		_, data, err := ws.Read(ctx)
		if err != nil || !strings.Contains(string(data), `"type":"access.revoked"`) ||
			!strings.Contains(string(data), `"reason":"link_replaced"`) {
			t.Errorf("live update after rotating = %s, %v; want access.revoked for a replaced link", data, err)
		}
		if _, _, err := ws.Read(ctx); websocket.CloseStatus(err) != realtime.StatusRevoked {
			t.Errorf("read after access.revoked = %v, want close status %d", err, realtime.StatusRevoked)
		}
	}
	if got := p.livekit.Removed(); len(got) != len(inVoice) || !slices.Contains(got, inVoice[0]) || !slices.Contains(got, inVoice[1]) {
		t.Errorf("removed from voice %+v, want %+v", got, inVoice)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("rotation took %v, want at most two seconds", elapsed)
	}

	// Every old cookie is refused, on every endpoint.
	for _, b := range []*api.ClientWithResponses{bob, ann} {
		me, err := b.GetMeWithResponse(t.Context())
		if err != nil {
			t.Fatalf("GetMe: %v", err)
		}
		wantError(t, "GetMe with an old cookie", me.StatusCode(), me.Body, http.StatusUnauthorized, "visitor_required")
		rooms, err := b.ListRoomsWithResponse(t.Context())
		if err != nil {
			t.Fatalf("ListRooms: %v", err)
		}
		wantError(t, "ListRooms with an old cookie", rooms.StatusCode(), rooms.Body, http.StatusUnauthorized, "visitor_required")
		history, err := b.ListMessagesWithResponse(t.Context(), lounge.ID, nil)
		if err != nil {
			t.Fatalf("ListMessages: %v", err)
		}
		wantError(t, "ListMessages with an old cookie", history.StatusCode(), history.Body, http.StatusUnauthorized, "visitor_required")
		joined := joinVoice(t, b, lounge.ID)
		wantError(t, "JoinVoice with an old cookie", joined.StatusCode(), joined.Body, http.StatusUnauthorized, "visitor_required")
	}
	status, body := p.upgradeRequest(t, bobHTTP, testOrigin)
	wantError(t, "GET /api/live with an old cookie", status, body, http.StatusUnauthorized, "visitor_required")

	// Entering takes the new secret, and makes a new visitor.
	old, err := p.browser(t).EnterWithResponse(t.Context(), api.EnterRequest{Secret: oldSecret, Name: "Carol"})
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	wantError(t, "Enter with the old secret", old.StatusCode(), old.Body, http.StatusForbidden, "invalid_link")
	p.secret = strings.TrimPrefix(link, testOrigin+"/#k=")
	again := p.browser(t)
	if v := p.enter(t, again, "Bob"); v.Id == bobVisitor.Id {
		t.Errorf("Enter with the new secret = %+v, want a new visitor", v)
	}
	for _, room := range []string{lounge.ID, games.ID} {
		if got := occupancy(t, again, room); len(got) != 0 {
			t.Errorf("occupancy of %s after rotating = %+v, want none", room, got)
		}
	}
}

func TestAfterARotationThatDidNotEmptyVoiceOldParticipantsAreRemovedByTheChecks(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	bob := p.browser(t)
	bobVisitor := p.enter(t, bob, "Bob")
	first := p.inVoice(t, bob, bobVisitor, lounge.ID)

	// As when the server stops, or LiveKit fails, between storing the new
	// link and emptying voice.
	if _, err := p.identity.Rotate(t.Context()); err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	// The refresh at startup, or the next one, removes Bob.
	if err := p.voice.Refresh(t.Context()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if got := p.livekit.Removed(); !slices.Equal(got, []voice.Participant{first}) {
		t.Errorf("removed after the refresh %+v, want %+v", got, first)
	}
	if got := p.voice.Occupancy(lounge.ID); len(got) != 0 {
		t.Errorf("occupancy after the refresh = %+v, want none", got)
	}

	// Bob rejoins with the token he still holds: his join is checked and
	// he is removed again.
	rejoined := p.livekit.AddParticipant(lounge.ID, bobVisitor.Id)
	p.applied(t, voicetest.Joined(rejoined))
	if got := p.livekit.Removed(); !slices.Equal(got, []voice.Participant{first, rejoined}) {
		t.Errorf("removed after rejoining %+v, want %+v", got, []voice.Participant{first, rejoined})
	}
	if got := p.voice.Occupancy(lounge.ID); len(got) != 0 {
		t.Errorf("occupancy after rejoining = %+v, want none", got)
	}
}
