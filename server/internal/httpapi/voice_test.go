package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/voice"
)

// joinVoice joins roomID's voice through b and returns the response, whatever
// it is.
func joinVoice(t *testing.T, b *api.ClientWithResponses, roomID string) *api.JoinVoiceResponse {
	t.Helper()
	res, err := b.JoinVoiceWithResponse(t.Context(), roomID)
	if err != nil {
		t.Fatalf("JoinVoice: %v", err)
	}
	return res
}

// joinedVoice joins roomID's voice through b and fails the test unless it
// returns credentials.
func joinedVoice(t *testing.T, b *api.ClientWithResponses, roomID string) api.VoiceCredentials {
	t.Helper()
	res := joinVoice(t, b, roomID)
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil {
		t.Fatalf("JoinVoice(%s) = %d %s, want 200", roomID, res.StatusCode(), res.Body)
	}
	return *res.JSON200
}

func TestJoiningVoiceReturnsATokenForThatRoomOnly(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	bob := p.enter(t, b, "Bob")

	creds := joinedVoice(t, b, lounge.ID)
	if creds.Url != testLiveKitURL {
		t.Errorf("url = %q, want %q", creds.Url, testLiveKitURL)
	}
	verifier, err := auth.ParseAPIToken(creds.Token)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	claims, grants, err := verifier.Verify(testLiveKitSecret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if grants.Identity != bob.Id || grants.Name != "Bob" {
		t.Errorf("identity, name = %q, %q, want %q, Bob", grants.Identity, grants.Name, bob.Id)
	}
	if until := time.Until(claims.ExpiresAt.Time); until < 9*time.Minute || until > 10*time.Minute {
		t.Errorf("token expires in %v, want about 10 minutes", until)
	}
	g := grants.Video
	if g == nil || !g.RoomJoin || g.Room != lounge.ID || g.RoomAdmin || g.RoomCreate || g.RoomList {
		t.Fatalf("video grant = %+v, want joining %s only", g, lounge.ID)
	}
	wantSources := []livekit.TrackSource{
		livekit.TrackSource_MICROPHONE, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO,
	}
	if !slices.Equal(g.GetCanPublishSources(), wantSources) || !g.GetCanSubscribe() ||
		!g.GetCanUpdateOwnMetadata() || g.GetCanPublishData() {
		t.Errorf("video grant = %+v, want publishing %v, subscribing and own metadata, no data", g, wantSources)
	}
}

func TestJoiningVoiceNeedsAVisitorAndAnExistingRoom(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	res := joinVoice(t, b, lounge.ID)
	wantError(t, "JoinVoice without a cookie", res.StatusCode(), res.Body, http.StatusUnauthorized, "visitor_required")

	p.enter(t, b, "Bob")
	res = joinVoice(t, b, "01JBX6Z8Q3M5W2K7R9T4V1C0DE")
	wantError(t, "JoinVoice of an unknown room", res.StatusCode(), res.Body, http.StatusNotFound, "room_not_found")
}

func TestJoiningAnotherRoomsVoiceRemovesTheVisitorFromThePreviousOne(t *testing.T) {
	p := startPublic(t, 10)
	lounge, games := p.createRoom(t, "Lounge"), p.createRoom(t, "Games")
	b := p.browser(t)
	bob := p.enter(t, b, "Bob")

	joinedVoice(t, b, lounge.ID)
	p.livekit.AddParticipant(lounge.ID, bob.Id)
	joinedVoice(t, b, games.ID)
	want := []voice.Participant{{Room: lounge.ID, Identity: bob.Id}}
	if got := p.livekit.Removed(); !slices.Equal(got, want) {
		t.Errorf("removed = %+v, want %+v", got, want)
	}
}

func TestJoiningAFullRoomsVoiceIsRefusedUnlessTheVisitorIsInIt(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	for i := range testRoomCap - 1 {
		p.livekit.AddParticipant(lounge.ID, fmt.Sprintf("visitor-%d", i))
	}
	bob, carol := p.browser(t), p.browser(t)
	bobV := p.enter(t, bob, "Bob")
	p.enter(t, carol, "Carol")

	joinedVoice(t, bob, lounge.ID)
	p.livekit.AddParticipant(lounge.ID, bobV.Id)
	res := joinVoice(t, carol, lounge.ID)
	wantError(t, "JoinVoice of a full room", res.StatusCode(), res.Body, http.StatusConflict, "room_full")

	// A second tab of Bob's replaces his first connection.
	joinedVoice(t, bob, lounge.ID)
}

func TestJoiningVoiceAnswersUnavailableWhileLiveKitIsUnreachable(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	p.enter(t, b, "Bob")

	p.livekit.Fail(errors.New("connection refused"))
	res := joinVoice(t, b, lounge.ID)
	wantError(t, "JoinVoice while LiveKit is down", res.StatusCode(), res.Body, http.StatusServiceUnavailable, "voice_unavailable")
	p.livekit.Fail(nil)
	joinedVoice(t, b, lounge.ID)
}

func TestTheLiveKitSecretIsNeitherAnsweredNorLogged(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	p.enter(t, b, "Bob")

	creds := joinedVoice(t, b, lounge.ID)
	p.livekit.Fail(errors.New("connection refused"))
	failed := joinVoice(t, b, lounge.ID)
	for what, text := range map[string]string{
		"the credentials":   creds.Url + " " + creds.Token,
		"the failed answer": string(failed.Body),
		"the logs":          p.logs.String(),
	} {
		if strings.Contains(text, testLiveKitSecret) {
			t.Errorf("%s contain the LiveKit API secret", what)
		}
	}
	if strings.Contains(p.logs.String(), creds.Token) {
		t.Error("the logs contain a voice token")
	}
}
