package voice_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

// change is one occupancy the Service published.
type change struct {
	room      string
	occupancy []identity.Visitor
}

// recorder records what the Service publishes.
type recorder struct {
	mu      sync.Mutex
	changes []change
}

func (r *recorder) publish(room string, occupancy []identity.Visitor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.changes = append(r.changes, change{room, occupancy})
}

func (r *recorder) published() []change {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.changes)
}

func equalChanges(a, b []change) bool {
	return slices.EqualFunc(a, b, func(x, y change) bool { return x.room == y.room && slices.Equal(x.occupancy, y.occupancy) })
}

type fixture struct {
	s       *voice.Service
	livekit *voicetest.LiveKit
	access  *access
	changes *recorder
}

// newFixture returns a Service whose participants may stay while they are
// among visitors.
func newFixture(visitors ...identity.Visitor) fixture {
	f := fixture{livekit: voicetest.New(), access: newAccess(visitors...), changes: &recorder{}}
	f.s = voice.New(f.livekit, f.access, f.access, voice.Config{
		URL: testURL, APIKey: testKey, APISecret: testSecret, RoomCap: 8,
	}, voice.WithPublisher(f.changes.publish))
	return f
}

// signed returns the webhook request carrying event, signed with key and
// secret.
func signed(t *testing.T, event *livekit.WebhookEvent, key, secret string) *http.Request {
	t.Helper()
	body, authorization, err := voicetest.Sign(event, key, secret)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/livekit/webhook", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/webhook+json")
	r.Header.Set("Authorization", authorization)
	return r
}

// receive hands the Service event, signed as LiveKit signs it, and fails the
// test unless it applies.
func (f fixture) receive(t *testing.T, event *livekit.WebhookEvent) {
	t.Helper()
	if err := f.s.ReceiveWebhook(signed(t, event, testKey, testSecret)); err != nil {
		t.Fatalf("ReceiveWebhook(%s): %v", event.GetEvent(), err)
	}
}

// join issues v a token for room's voice and makes them a participant there.
func (f fixture) join(t *testing.T, v identity.Visitor, room string) voice.Participant {
	t.Helper()
	if _, err := f.s.Join(t.Context(), v, room); err != nil {
		t.Fatalf("Join(%s, %s): %v", v.Name, room, err)
	}
	return f.livekit.AddParticipant(room, v.ID)
}

func wantOccupancy(t *testing.T, s *voice.Service, room string, want ...identity.Visitor) {
	t.Helper()
	if got := s.Occupancy(room); !slices.Equal(got, want) {
		t.Errorf("Occupancy(%s) = %+v, want %+v", room, got, want)
	}
}

var (
	alice = identity.Visitor{ID: "01JBX6Y7P2L4V1J6Q8S3U0B9CD", Name: "alice"}
	carol = identity.Visitor{ID: "01JBX6ZA1B2C3D4E5F6G7H8J9K", Name: "Carol"}
)

func TestASignedJoinAddsTheParticipantAndALeaveRemovesThem(t *testing.T) {
	f := newFixture(bob, alice)
	inA := f.join(t, bob, roomA)
	f.receive(t, voicetest.Joined(inA))
	wantOccupancy(t, f.s, roomA, bob)

	alicesTab := f.join(t, alice, roomA)
	f.receive(t, voicetest.Joined(alicesTab))
	// By name, case-insensitively.
	wantOccupancy(t, f.s, roomA, alice, bob)

	f.receive(t, voicetest.Left(inA))
	f.receive(t, voicetest.Left(inA)) // again, as a retried delivery
	wantOccupancy(t, f.s, roomA, alice)
	want := []change{{roomA, []identity.Visitor{bob}}, {roomA, []identity.Visitor{alice, bob}}, {roomA, []identity.Visitor{alice}}}
	if got := f.changes.published(); !equalChanges(got, want) {
		t.Errorf("published %+v, want %+v", got, want)
	}
	if got := f.livekit.Removed(); len(got) != 0 {
		t.Errorf("removed %+v, want no one", got)
	}
}

func TestWebhooksWithoutAValidSignatureChangeNothing(t *testing.T) {
	f := newFixture(bob)
	joined := voicetest.Joined(f.join(t, bob, roomA))
	for name, r := range map[string]*http.Request{
		"unsigned":           unsigned(t, joined),
		"wrong secret":       signed(t, joined, testKey, "another-secret-of-at-least-32-characters"),
		"unknown API key":    signed(t, joined, "someone", testSecret),
		"body not as signed": tampered(t, joined),
	} {
		if err := f.s.ReceiveWebhook(r); !errors.Is(err, voice.ErrUnverifiedWebhook) {
			t.Errorf("ReceiveWebhook, %s: %v, want ErrUnverifiedWebhook", name, err)
		}
	}
	wantOccupancy(t, f.s, roomA)
	if got := f.changes.published(); len(got) != 0 {
		t.Errorf("published %+v, want nothing", got)
	}
}

// unsigned is the webhook request carrying event without a signature.
func unsigned(t *testing.T, event *livekit.WebhookEvent) *http.Request {
	t.Helper()
	r := signed(t, event, testKey, testSecret)
	r.Header.Del("Authorization")
	return r
}

// tampered is event signed, with another event as its body.
func tampered(t *testing.T, event *livekit.WebhookEvent) *http.Request {
	t.Helper()
	r := signed(t, event, testKey, testSecret)
	body, _, err := voicetest.Sign(voicetest.RoomFinished(event.GetRoom().GetName()), testKey, testSecret)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return r
}

func TestAJoinOfAParticipantWhoMayNotStayRemovesThemAndChangesNothing(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(f fixture) voice.Participant
	}{
		{"unknown visitor", func(f fixture) voice.Participant {
			return f.livekit.AddParticipant(roomA, "01JBX6ZZZZZZZZZZZZZZZZZZZZ")
		}},
		{"access ended", func(f fixture) voice.Participant {
			p := f.join(t, bob, roomA)
			f.access.revoke(bob.ID)
			return p
		}},
		{"name taken", func(f fixture) voice.Participant {
			p := f.join(t, bob, roomA)
			f.access.takeName(bob.ID)
			return p
		}},
		{"issued another room", func(f fixture) voice.Participant {
			f.join(t, bob, roomA)
			if _, err := f.s.Join(t.Context(), bob, roomB); err != nil {
				t.Fatalf("Join: %v", err)
			}
			// Back in the first room with the token they still hold.
			return f.livekit.AddParticipant(roomA, bob.ID)
		}},
		{"no such room", func(f fixture) voice.Participant { return f.join(t, bob, "01JBX7CCCCCCCCCCCCCCCCCCCC") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(bob)
			p := tc.setup(f)
			removedBefore := len(f.livekit.Removed())
			f.receive(t, voicetest.Joined(p))
			if got := f.livekit.Removed()[removedBefore:]; !slices.Equal(got, []voice.Participant{p}) {
				t.Errorf("removed %+v, want %+v", got, p)
			}
			wantOccupancy(t, f.s, p.Room)
			if got := f.changes.published(); len(got) != 0 {
				t.Errorf("published %+v, want nothing", got)
			}
		})
	}
}

func TestAVisitorInTheirIssuedRoomIsKeptAndTheirSecondTabTakesNoPlace(t *testing.T) {
	f := newFixture(bob)
	first := f.join(t, bob, roomA)
	f.receive(t, voicetest.Joined(first))
	second := f.join(t, bob, roomA)
	f.receive(t, voicetest.Joined(second))
	wantOccupancy(t, f.s, roomA, bob)
	f.receive(t, voicetest.Left(first))
	wantOccupancy(t, f.s, roomA, bob)
	if got := f.livekit.Removed(); len(got) != 0 {
		t.Errorf("removed %+v, want no one", got)
	}
	if got, want := f.changes.published(), []change{{roomA, []identity.Visitor{bob}}}; !equalChanges(got, want) {
		t.Errorf("published %+v, want %+v", got, want)
	}
}

func TestAFinishedRoomIsEmpty(t *testing.T) {
	f := newFixture(bob)
	f.receive(t, voicetest.Joined(f.join(t, bob, roomA)))
	f.receive(t, voicetest.RoomFinished(roomA))
	wantOccupancy(t, f.s, roomA)
	if got, want := f.changes.published(), []change{{roomA, []identity.Visitor{bob}}, {roomA, nil}}; !equalChanges(got, want) {
		t.Errorf("published %+v, want %+v", got, want)
	}
}

func TestASignedBodyThatIsNotAnEventIsInvalid(t *testing.T) {
	f := newFixture(bob)
	r := signed(t, voicetest.Joined(f.join(t, bob, roomA)), testKey, testSecret)
	body := []byte("not an event")
	sum := sha256.Sum256(body)
	authorization, err := auth.NewAccessToken(testKey, testSecret).
		SetValidFor(time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).
		ToJWT()
	if err != nil {
		t.Fatalf("ToJWT: %v", err)
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.Header.Set("Authorization", authorization)
	if err := f.s.ReceiveWebhook(r); !errors.Is(err, voice.ErrInvalidWebhook) {
		t.Errorf("ReceiveWebhook = %v, want ErrInvalidWebhook", err)
	}
}

// startRun runs s's refresh loop until the test ends.
func startRun(t *testing.T, s *voice.Service) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func TestTheRefreshAtStartupKeepsTheParticipantsWhoMayStayAndRemovesTheOthers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		dave := identity.Visitor{ID: "01JBX6ZB2C3D4E5F6G7H8J9K0M", Name: "Dave"}
		f := newFixture(bob, carol, dave)
		// As after a restart, no token has been issued yet, so Bob may stay
		// in whichever room he is in.
		f.livekit.AddParticipant(roomB, bob.ID)
		unknown := f.livekit.AddParticipant(roomA, "01JBX6ZZZZZZZZZZZZZZZZZZZZ")
		f.livekit.AddParticipant(roomA, carol.ID)
		f.access.takeName(dave.ID)
		taken := f.livekit.AddParticipant(roomA, dave.ID)

		startRun(t, f.s)
		synctest.Wait()
		wantOccupancy(t, f.s, roomA, carol)
		wantOccupancy(t, f.s, roomB, bob)
		if got, want := f.livekit.Removed(), []voice.Participant{unknown, taken}; !slices.Equal(got, want) {
			t.Errorf("removed %+v, want %+v", got, want)
		}
		want := []change{{roomA, []identity.Visitor{carol}}, {roomB, []identity.Visitor{bob}}}
		if got := f.changes.published(); !equalChanges(got, want) {
			t.Errorf("published %+v, want %+v", got, want)
		}

		// Carol moves to room B, which takes her out of room A, then returns
		// to room A with the token she still holds.
		if _, err := f.s.Join(t.Context(), carol, roomB); err != nil {
			t.Fatalf("Join: %v", err)
		}
		returned := f.livekit.AddParticipant(roomA, carol.ID)
		time.Sleep(voice.RefreshInterval)
		synctest.Wait()
		if got := f.livekit.Removed(); !slices.Contains(got, returned) {
			t.Errorf("removed %+v, want %+v among them", got, returned)
		}
		wantOccupancy(t, f.s, roomA)
	})
}

func TestADroppedWebhookIsCorrectedByTheNextRefresh(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture(bob)
		startRun(t, f.s)
		synctest.Wait()

		// Bob joins, and the webhook saying so is lost.
		p := f.join(t, bob, roomA)
		time.Sleep(voice.RefreshInterval - time.Millisecond)
		synctest.Wait()
		wantOccupancy(t, f.s, roomA)
		time.Sleep(time.Millisecond)
		synctest.Wait()
		wantOccupancy(t, f.s, roomA, bob)

		// He renames, then leaves, and that webhook is lost too.
		robert := identity.Visitor{ID: bob.ID, Name: "Robert"}
		f.access.set(robert)
		time.Sleep(voice.RefreshInterval)
		synctest.Wait()
		wantOccupancy(t, f.s, roomA, robert)
		f.livekit.Leave(p)
		time.Sleep(voice.RefreshInterval)
		synctest.Wait()
		wantOccupancy(t, f.s, roomA)

		want := []change{{roomA, []identity.Visitor{bob}}, {roomA, []identity.Visitor{robert}}, {roomA, nil}}
		if got := f.changes.published(); !equalChanges(got, want) {
			t.Errorf("published %+v, want %+v", got, want)
		}
	})
}

func TestAFailedRefreshOrCheckLeavesTheView(t *testing.T) {
	f := newFixture(bob)
	p := f.join(t, bob, roomA)
	f.receive(t, voicetest.Joined(p))

	down := errors.New("connection refused")
	f.livekit.Fail(down)
	if err := f.s.Refresh(t.Context()); !errors.Is(err, voice.ErrUnavailable) {
		t.Errorf("Refresh while LiveKit is down = %v, want ErrUnavailable", err)
	}
	f.livekit.Fail(nil)
	f.access.fail(errors.New("database is locked"))
	if err := f.s.Refresh(t.Context()); err == nil {
		t.Error("Refresh while access cannot be checked = nil, want an error")
	}
	second := f.livekit.AddParticipant(roomA, bob.ID)
	if err := f.s.ReceiveWebhook(signed(t, voicetest.Joined(second), testKey, testSecret)); err == nil ||
		errors.Is(err, voice.ErrUnverifiedWebhook) {
		t.Errorf("ReceiveWebhook while access cannot be checked = %v, want an error for LiveKit to retry", err)
	}
	wantOccupancy(t, f.s, roomA, bob)
	if got := f.livekit.Removed(); len(got) != 0 {
		t.Errorf("removed %+v, want no one", got)
	}
}
