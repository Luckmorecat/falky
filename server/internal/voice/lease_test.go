package voice_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

type idleClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *idleClock) read() time.Time         { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *idleClock) advance(d time.Duration) { c.mu.Lock(); defer c.mu.Unlock(); c.now = c.now.Add(d) }

func idleService(t *testing.T, lk voice.LiveKit, opts ...voice.Option) (*voice.Service, *idleClock) {
	t.Helper()
	clock := &idleClock{now: time.Now()}
	opts = append(opts, voice.WithClock(clock.read))
	a := newAccess(bob)
	s := voice.New(lk, a, a, voice.Config{APIKey: testKey, APISecret: testSecret, RoomCap: 8}, opts...)
	s.ConfigureAdmission(&sync.Mutex{}, func(_ context.Context, session identity.Session) (identity.Session, error) { return session, nil }, "https://falky.example")
	return s, clock
}

func leaseStatus(t *testing.T, s *voice.Service, token string) int {
	t.Helper()
	// The upstream need not be reachable: 502 proves admission succeeded, while
	// expired grants must be refused locally with 403. JWT time stays real.
	rr := httptest.NewRecorder()
	s.Signalling("http://127.0.0.1:1").ServeHTTP(rr, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/rtc/validate?access_token="+token, nil))
	return rr.Code
}

func TestUnusedGrantIdleDeadlineAndIndependentFreshJoin(t *testing.T) {
	s, clock := idleService(t, voicetest.New())
	old, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	clock.advance(10*time.Minute - time.Nanosecond)
	if got := leaseStatus(t, s, old.Token); got != http.StatusBadGateway {
		t.Fatalf("before deadline: %d", got)
	}
	clock.advance(time.Nanosecond)
	if got := leaseStatus(t, s, old.Token); got != http.StatusForbidden {
		t.Fatalf("at deadline: %d", got)
	}
	fresh, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.GrantID == old.GrantID {
		t.Fatal("Join reused expired grant")
	}
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, fresh.Token); got != http.StatusBadGateway {
		t.Fatalf("fresh sibling: %d", got)
	}
	clock.advance(time.Second)
	if got := leaseStatus(t, s, old.Token); got != http.StatusForbidden {
		t.Fatalf("after cleanup: %d", got)
	}
}

func TestAuthoritativePresenceSurvivesAgeAndAbsenceStartsFullGrace(t *testing.T) {
	lk := voicetest.New()
	s, clock := idleService(t, lk)
	creds, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	p := lk.AddParticipant(roomA, creds.GrantID)
	clock.advance(25 * time.Minute)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("present old grant: %d", got)
	}
	// Missed departure webhook is healed by the full participant listing.
	lk.Leave(p)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(10*time.Minute - time.Nanosecond)
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("new absence grace: %d", got)
	}
	clock.advance(time.Nanosecond)
	if got := leaseStatus(t, s, creds.Token); got != 403 {
		t.Fatalf("absence deadline: %d", got)
	}
}

func TestFailedListingDoesNotInventAbsenceOrAuthorizeIdleDestruction(t *testing.T) {
	lk := voicetest.New()
	s, clock := idleService(t, lk)
	creds, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	p := lk.AddParticipant(roomA, creds.GrantID)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	lk.Leave(p)
	lk.Fail(errors.New("list unavailable"))
	clock.advance(20 * time.Minute)
	if err := s.Refresh(t.Context()); !errors.Is(err, voice.ErrUnavailable) {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("unknown absence started a timer: %d", got)
	}
	lk.Fail(nil)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(10 * time.Minute)
	lk.Fail(errors.New("list unavailable"))
	if err := s.Refresh(t.Context()); !errors.Is(err, voice.ErrUnavailable) {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, creds.Token); got != 403 {
		t.Fatalf("known deadline lost: %d", got)
	}
	// A fresh authoritative presence cancels stale absence, even after deadline.
	lk.AddParticipant(roomA, creds.GrantID)
	lk.Fail(nil)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("outage destroyed actually present grant: %d", got)
	}
}

type signalFixture struct {
	mu              sync.Mutex
	entered, resume chan struct{}
	fail            bool
	lk              *voicetest.LiveKit
}

func (f *signalFixture) block(fail bool) (<-chan struct{}, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entered, f.resume, f.fail = make(chan struct{}), make(chan struct{}), fail
	resume := f.resume
	return f.entered, sync.OnceFunc(func() { close(resume) })
}

func (f *signalFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/validate") {
		w.WriteHeader(200)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = conn.CloseNow() }()
	f.mu.Lock()
	entered, resume, fail := f.entered, f.resume, f.fail
	f.entered = nil
	f.resume = nil
	f.mu.Unlock()
	if entered != nil {
		close(entered)
		select {
		case <-resume:
		case <-r.Context().Done():
			return
		}
	}
	if fail {
		return
	}
	verifier, err := auth.ParseAPIToken(r.URL.Query().Get("access_token"))
	if err != nil {
		return
	}
	_, grants, err := verifier.Verify(testSecret)
	if err != nil {
		return
	}
	p := f.lk.AddParticipant(grants.Video.Room, grants.Identity)
	data, _ := proto.Marshal(&livekit.SignalResponse{Message: &livekit.SignalResponse_Join{Join: &livekit.JoinResponse{Participant: &livekit.ParticipantInfo{Identity: p.Identity, Sid: p.SID}}}})
	if err := conn.Write(r.Context(), websocket.MessageBinary, data); err != nil {
		return
	}
	for {
		if _, _, err := conn.Read(r.Context()); err != nil {
			return
		}
	}
}

func leaseGuard(t *testing.T, s *voice.Service, lk *voicetest.LiveKit) (*httptest.Server, *signalFixture) {
	t.Helper()
	fixture := &signalFixture{lk: lk}
	upstream := httptest.NewServer(fixture)
	guard := httptest.NewServer(s.Signalling(upstream.URL))
	t.Cleanup(func() { s.CloseSignalling(); guard.Close(); upstream.Close() })
	return guard, fixture
}

func dialLease(t *testing.T, guard *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	ws, response, err := websocket.Dial(ctx, guard.URL+"/rtc?access_token="+url.QueryEscape(token), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ws.Read(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	return ws
}

func TestActualReconnectClearsLeaseAndStaleEventsCannotChangeIt(t *testing.T) {
	lk := voicetest.New()
	s, clock := idleService(t, lk)
	guard, _ := leaseGuard(t, s, lk)
	creds, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	old := lk.AddParticipant(roomA, creds.GrantID)
	clock.advance(10*time.Minute - time.Nanosecond)
	ws := dialLease(t, guard, creds.Token)
	current, err := lk.Participants(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	// Successful actual admission clears immediately, without waiting for a list.
	clock.advance(15 * time.Minute)
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("handshake failed to clear lease: %d", got)
	}
	for _, event := range []*livekit.WebhookEvent{voicetest.Left(old), voicetest.RoomFinished(roomA), voicetest.Joined(old)} {
		if err := s.ReceiveWebhook(signed(t, event, testKey, testSecret)); err != nil {
			t.Fatal(err)
		}
	}
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("stale events changed lease: %d", got)
	}
	_ = ws.CloseNow()
	lk.Leave(current[0])
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(10*time.Minute - time.Nanosecond)
	// A validate probe must not cancel the next deadline.
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("subsequent full grace: %d", got)
	}
	clock.advance(time.Nanosecond)
	if got := leaseStatus(t, s, creds.Token); got != 403 {
		t.Fatalf("probe extended grace: %d", got)
	}
}

type heldLeaseListing struct {
	*voicetest.LiveKit
	mu              sync.Mutex
	entered, resume chan struct{}
}

func (lk *heldLeaseListing) hold() (<-chan struct{}, func()) {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	lk.entered, lk.resume = make(chan struct{}), make(chan struct{})
	resume := lk.resume
	return lk.entered, sync.OnceFunc(func() { close(resume) })
}

func (lk *heldLeaseListing) Participants(ctx context.Context) ([]voice.Participant, error) {
	participants, err := lk.LiveKit.Participants(ctx)
	lk.mu.Lock()
	entered, resume := lk.entered, lk.resume
	lk.entered = nil
	lk.resume = nil
	lk.mu.Unlock()
	if entered != nil {
		close(entered)
		select {
		case <-resume:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return participants, err
}

func TestStaleAbsenceCannotExpireAcceptedReconnectOrNewGrant(t *testing.T) {
	lk := &heldLeaseListing{LiveKit: voicetest.New()}
	s, clock := idleService(t, lk)
	guard, _ := leaseGuard(t, s, lk.LiveKit)
	creds, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	clock.advance(10*time.Minute - time.Nanosecond)
	entered, release := lk.hold()
	defer release()
	refreshed := make(chan error, 1)
	go func() { refreshed <- s.Refresh(t.Context()) }()
	<-entered
	dialLease(t, guard, creds.Token)
	fresh, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	clock.advance(time.Minute)
	release()
	if err := <-refreshed; err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{creds.Token, fresh.Token} {
		if got := leaseStatus(t, s, token); got != 502 {
			t.Fatalf("stale listing fenced changed/new grant: %d", got)
		}
	}
}

func TestPendingHandshakeWinsBeforeDeadlineAndFailureDoesNotRenew(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			lk := voicetest.New()
			s, clock := idleService(t, lk)
			guard, upstream := leaseGuard(t, s, lk)
			creds, err := s.Join(t.Context(), bob, roomA)
			if err != nil {
				t.Fatal(err)
			}
			clock.advance(10*time.Minute - time.Nanosecond)
			entered, release := upstream.block(fail)
			defer release()
			result := make(chan error, 1)
			go func() {
				ws, res, err := websocket.Dial(t.Context(), guard.URL+"/rtc?access_token="+url.QueryEscape(creds.Token), nil)
				if res != nil && res.Body != nil {
					_ = res.Body.Close()
				}
				if ws != nil {
					defer func() { _ = ws.CloseNow() }()
					_, _, err = ws.Read(t.Context())
				}
				result <- err
			}()
			<-entered
			clock.advance(time.Minute)
			if err := s.Refresh(t.Context()); err != nil {
				t.Fatal(err)
			}
			release()
			err = <-result
			if fail && err == nil {
				t.Fatal("failed handshake succeeded")
			}
			if !fail && err != nil {
				t.Fatal(err)
			}
			want := 502
			if fail {
				want = 403
			}
			if got := leaseStatus(t, s, creds.Token); got != want {
				t.Fatalf("after handshake failure=%t: %d", fail, got)
			}
		})
	}
}

func TestAbsenceGraceBeginsWhenSuccessfulListingCompletes(t *testing.T) {
	lk := &heldLeaseListing{LiveKit: voicetest.New()}
	s, clock := idleService(t, lk)
	creds, err := s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	participant := lk.AddParticipant(roomA, creds.GrantID)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	lk.Leave(participant)
	entered, release := lk.hold()
	defer release()
	done := make(chan error, 1)
	go func() { done <- s.Refresh(t.Context()) }()
	<-entered
	clock.advance(20 * time.Minute)
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	clock.advance(10*time.Minute - time.Nanosecond)
	if got := leaseStatus(t, s, creds.Token); got != 502 {
		t.Fatalf("slow listing backdated absence: %d", got)
	}
	clock.advance(time.Nanosecond)
	if got := leaseStatus(t, s, creds.Token); got != 403 {
		t.Fatalf("successful observation deadline: %d", got)
	}
}
