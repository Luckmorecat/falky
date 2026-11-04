package voice_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

const (
	testURL    = "wss://falky.example"
	testKey    = "falky"
	testSecret = "a-secret-of-at-least-32-characters"
	roomA      = "01JBX7A2K9D4F6H8M0P3R5T7VW"
	roomB      = "01JBX7B3M1E5G7J9N2Q4S6V8XY"
)

var bob = identity.Visitor{ID: "01JBX6Z8Q3M5W2K7R9T4V1C0DE", Name: "Bob"}

// access is the visitors and rooms a test's Service checks participants
// against: visitors with current access, the rooms that exist, and the
// visitors whose name another visitor holds.
type access struct {
	mu        sync.Mutex
	visitors  map[string]identity.Visitor
	rooms     []string
	nameTaken map[string]bool
	err       error
}

// newAccess returns the access of the given visitors to roomA and roomB.
func newAccess(visitors ...identity.Visitor) *access {
	a := &access{visitors: map[string]identity.Visitor{}, rooms: []string{roomA, roomB}, nameTaken: map[string]bool{}}
	for _, v := range visitors {
		a.visitors[v.ID] = v
	}
	return a
}

// set gives v current access under v's name.
func (a *access) set(v identity.Visitor) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.visitors[v.ID] = v
}

// revoke ends the access of the visitor visitorID.
func (a *access) revoke(visitorID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.visitors, visitorID)
}

// takeName makes another visitor hold the name of the visitor visitorID.
func (a *access) takeName(visitorID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nameTaken[visitorID] = true
}

// fail makes every check fail with err until it is called with nil.
func (a *access) fail(err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.err = err
}

func (a *access) Visitor(_ context.Context, visitorID string) (identity.Visitor, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.err != nil {
		return identity.Visitor{}, a.err
	}
	v, ok := a.visitors[visitorID]
	if !ok {
		return identity.Visitor{}, identity.ErrNoVisitor
	}
	return v, nil
}

func (a *access) Authorize(_ context.Context, v identity.Visitor, roomID string, action rooms.Action) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case a.err != nil:
		return a.err
	case !slices.Contains(a.rooms, roomID):
		return rooms.ErrNotFound
	case action == rooms.JoinVoice && a.nameTaken[v.ID]:
		return identity.ErrNameTaken
	}
	return nil
}

func newService(roomCap int) (*voice.Service, *voicetest.LiveKit) {
	lk := voicetest.New()
	return voice.New(lk, newAccess(bob), newAccess(bob), voice.Config{
		URL: testURL, APIKey: testKey, APISecret: testSecret, RoomCap: roomCap,
	}), lk
}

// decodeToken verifies token with the test secret and returns what it grants and
// when it expires.
func decodeToken(t *testing.T, token string) (*auth.ClaimGrants, time.Time) {
	t.Helper()
	v, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	if v.APIKey() != testKey {
		t.Errorf("token API key = %q, want %q", v.APIKey(), testKey)
	}
	claims, grants, err := v.Verify(testSecret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	return grants, claims.ExpiresAt.Time
}

func TestJoinIssuesATokenForThatRoomOnly(t *testing.T) {
	s, _ := newService(8)
	creds, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if creds.URL != testURL {
		t.Errorf("URL = %q, want %q", creds.URL, testURL)
	}
	if strings.Contains(creds.Token, testSecret) {
		t.Error("the token contains the API secret")
	}

	grants, expires := decodeToken(t, creds.Token)
	if grants.Identity != bob.ID || grants.Name != bob.Name {
		t.Errorf("identity, name = %q, %q, want %q, %q", grants.Identity, grants.Name, bob.ID, bob.Name)
	}
	if until := time.Until(expires); until < voice.TokenLifetime-time.Minute || until > voice.TokenLifetime {
		t.Errorf("token expires in %v, want about %v", until, voice.TokenLifetime)
	}
	g := grants.Video
	if g == nil {
		t.Fatal("token has no video grant")
	}
	if !g.RoomJoin || g.Room != roomA || g.RoomCreate || g.RoomList || g.RoomAdmin || g.RoomRecord {
		t.Errorf("room grants = %+v, want joining %s only", g, roomA)
	}
	wantSources := []livekit.TrackSource{
		livekit.TrackSource_MICROPHONE, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO,
	}
	if !g.GetCanPublish() || !slices.Equal(g.GetCanPublishSources(), wantSources) {
		t.Errorf("publish = %v %v, want %v", g.GetCanPublish(), g.GetCanPublishSources(), wantSources)
	}
	if g.GetCanPublishSource(livekit.TrackSource_CAMERA) {
		t.Error("the token may publish a camera")
	}
	if !g.GetCanSubscribe() || !g.GetCanUpdateOwnMetadata() || g.GetCanPublishData() {
		t.Errorf("subscribe, own metadata, data = %v %v %v, want true true false",
			g.GetCanSubscribe(), g.GetCanUpdateOwnMetadata(), g.GetCanPublishData())
	}
	if rc := grants.GetRoomConfiguration(); rc == nil || rc.MaxParticipants != 8 {
		t.Errorf("room configuration = %+v, want at most 8 participants", rc)
	}
}

func TestJoinRecordsTheRoomLastIssued(t *testing.T) {
	s, _ := newService(8)
	if room, ok := s.IssuedRoom(bob.ID); ok {
		t.Errorf("IssuedRoom before joining = %q, want none", room)
	}
	for _, room := range []string{roomA, roomB} {
		if _, err := s.Join(t.Context(), bob, room); err != nil {
			t.Fatalf("Join(%s): %v", room, err)
		}
		if got, ok := s.IssuedRoom(bob.ID); !ok || got != room {
			t.Errorf("IssuedRoom after joining %s = %q, %v, want %s", room, got, ok, room)
		}
	}
}

func TestJoiningAnotherRoomRemovesTheVisitorFromThePreviousOne(t *testing.T) {
	s, lk := newService(8)
	inA := lk.AddParticipant(roomA, bob.ID)
	lk.AddParticipant(roomA, "alice")
	if _, err := s.Join(t.Context(), bob, roomB); err != nil {
		t.Fatalf("Join: %v", err)
	}
	want := []voice.Participant{inA}
	if got := lk.Removed(); !slices.Equal(got, want) {
		t.Errorf("removed = %+v, want %+v", got, want)
	}
}

func TestJoiningTheSameRoomAgainRemovesNoOne(t *testing.T) {
	s, lk := newService(8)
	lk.AddParticipant(roomA, bob.ID)
	if _, err := s.Join(t.Context(), bob, roomA); err != nil {
		t.Fatalf("Join: %v", err)
	}
	if got := lk.Removed(); len(got) != 0 {
		t.Errorf("removed = %+v, want no one", got)
	}
}

func TestJoiningAFullRoomIsRefusedAndKeepsTheVisitorWhereTheyAre(t *testing.T) {
	s, lk := newService(2)
	lk.AddParticipant(roomA, "alice")
	lk.AddParticipant(roomA, "carol")
	lk.AddParticipant(roomB, bob.ID)
	if _, err := s.Join(t.Context(), bob, roomA); !errors.Is(err, voice.ErrRoomFull) {
		t.Fatalf("Join of a full room: %v, want ErrRoomFull", err)
	}
	if got := lk.Removed(); len(got) != 0 {
		t.Errorf("removed = %+v, want no one", got)
	}
	if room, ok := s.IssuedRoom(bob.ID); ok {
		t.Errorf("IssuedRoom = %q, want none", room)
	}
}

func TestAVisitorAlreadyInAFullRoomMayJoinItAgain(t *testing.T) {
	s, lk := newService(2)
	lk.AddParticipant(roomA, "alice")
	lk.AddParticipant(roomA, bob.ID)
	if _, err := s.Join(t.Context(), bob, roomA); err != nil {
		t.Errorf("Join of the full room Bob is in: %v, want a token for a second tab", err)
	}
}

func TestJoinFailsWhileLiveKitIsUnreachable(t *testing.T) {
	s, lk := newService(8)
	down := errors.New("connection refused")
	lk.Fail(down)
	if _, err := s.Join(t.Context(), bob, roomA); !errors.Is(err, voice.ErrUnavailable) || !errors.Is(err, down) {
		t.Errorf("Join: %v, want ErrUnavailable wrapping %v", err, down)
	}
	if room, ok := s.IssuedRoom(bob.ID); ok {
		t.Errorf("IssuedRoom = %q, want none", room)
	}
	if err := s.Check(t.Context()); !errors.Is(err, down) {
		t.Errorf("Check = %v, want %v", err, down)
	}
	lk.Fail(nil)
	if err := s.Check(t.Context()); err != nil {
		t.Errorf("Check once LiveKit is back = %v, want nil", err)
	}
}
