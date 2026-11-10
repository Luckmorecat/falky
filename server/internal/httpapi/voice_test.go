package httpapi

import (
	"context"
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
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/voice"
)

// joinVoice joins roomID's voice through b and returns the response, whatever
// it is.
func joinVoice(t *testing.T, b *api.ClientWithResponses, roomID string) *api.JoinVoiceResponse {
	t.Helper()
	res, err := b.JoinVoiceWithBodyWithResponse(t.Context(), roomID, "application/json", nil, func(_ context.Context, request *http.Request) error {
		request.Header.Set("Origin", testOrigin)
		return nil
	})
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
	if !strings.HasPrefix(grants.Identity, bob.Id+".") || grants.Name != "Bob" {
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
		livekit.TrackSource_MICROPHONE, livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO,
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

func TestJoiningAnotherRoomsVoicePreservesThePreviousConnection(t *testing.T) {
	p := startPublic(t, 10)
	lounge, games := p.createRoom(t, "Lounge"), p.createRoom(t, "Games")
	b := p.browser(t)
	p.enter(t, b, "Bob")

	old := joinedVoice(t, b, lounge.ID)
	p.livekit.AddParticipant(lounge.ID, old.GrantId)
	joinedVoice(t, b, games.ID)
	var want []voice.Participant
	if got := p.livekit.Removed(); !slices.Equal(got, want) {
		t.Errorf("removed = %+v, want %+v", got, want)
	}
}

func TestJoiningAFullRoomsVoiceCountsTheSamePersonsOtherConnection(t *testing.T) {
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

	res = joinVoice(t, bob, lounge.ID)
	wantError(t, "JoinVoice of a full room by another connection of Bob", res.StatusCode(), res.Body, http.StatusConflict, "room_full")
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

func TestLogoutDurablyRevokesOnlyItsSessionDespiteFailedMediaCleanup(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	first, firstHTTP := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, firstHTTP, "Account", key)
	second, _ := loginAccountBrowser(t, p, key)
	old := joinedVoice(t, first, room.ID)
	other := joinedVoice(t, second, room.ID)
	p.livekit.Fail(errors.New("media removal unavailable"))
	accountRequest(t, p, firstHTTP, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 500)
	p.livekit.Fail(nil)
	p = restartVoice(t, p)
	checkVoiceValidation(t, p, old.Token, 403)
	checkVoiceValidation(t, p, other.Token, 200)
}

func TestVoiceLeaveEndpointIsAbsent(t *testing.T) {
	p := startPublic(t, 100)
	_, browser := p.browserWithHTTP(t)
	enrollAccount(t, p, browser, "Account", passkeytest.New(t))
	accountRequest(t, p, browser, "POST", "/api/voice/leave", map[string]any{"grantId": "obsolete"}, testOrigin, 404)
}

func TestIndependentAccountConnectionsSurviveOtherJoinsLogoutAndRestart(t *testing.T) {
	p := startPublic(t, 100)
	lounge, games := p.createRoom(t, "Lounge"), p.createRoom(t, "Games")
	first, firstHTTP := p.browserWithHTTP(t)
	key := passkeytest.New(t)
	enrollAccount(t, p, firstHTTP, "Account", key)
	second, secondHTTP := loginAccountBrowser(t, p, key)
	one := joinedVoice(t, first, lounge.ID)
	two := joinedVoice(t, first, lounge.ID)
	three := joinedVoice(t, first, games.ID)
	four := joinedVoice(t, second, lounge.ID)
	p = restartVoice(t, p)
	for _, creds := range []api.VoiceCredentials{one, two, three, four} {
		checkVoiceValidation(t, p, creds.Token, 200)
	}
	accountRequest(t, p, firstHTTP, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	for _, creds := range []api.VoiceCredentials{one, two, three} {
		checkVoiceValidation(t, p, creds.Token, 403)
	}
	checkVoiceValidation(t, p, four.Token, 200)
	accountRequest(t, p, secondHTTP, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
	checkVoiceValidation(t, p, four.Token, 403)
}
