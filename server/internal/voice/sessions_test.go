package voice_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestTransientGrantPolicyFailuresPreserveExistingPermission(t *testing.T) {
	for _, stage := range []string{"session", "room"} {
		t.Run(stage, func(t *testing.T) {
			f := newFixture(bob)
			gate := &sync.Mutex{}
			var validationErr error
			f.s.ConfigureAdmission(gate, func(_ context.Context, session identity.Session) (identity.Session, error) {
				return session, validationErr
			}, "https://falky.example")
			creds, err := f.s.Join(t.Context(), bob, roomA)
			if err != nil {
				t.Fatal(err)
			}
			f.livekit.AddParticipant(roomA, creds.GrantID)
			if err := f.s.Refresh(t.Context()); err != nil {
				t.Fatal(err)
			}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))
			defer upstream.Close()
			guard := f.s.Signalling(upstream.URL)
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/rtc/validate?access_token="+creds.Token, nil)
			down := errors.New("temporary policy lookup failure")
			if stage == "session" {
				validationErr = down
			} else {
				f.access.fail(down)
			}
			gate.Lock()
			err = f.s.ValidateGrants(t.Context())
			gate.Unlock()
			if !errors.Is(err, down) {
				t.Fatalf("ValidateGrants = %v, want original policy failure", err)
			}
			if err := f.s.Refresh(t.Context()); !errors.Is(err, down) {
				t.Fatalf("Refresh = %v, want original policy failure", err)
			}
			wantOccupancy(t, f.s, roomA, bob)
			result := httptest.NewRecorder()
			guard.ServeHTTP(result, request)
			if result.Code != http.StatusServiceUnavailable {
				t.Fatalf("admission during policy failure = %d, want 503", result.Code)
			}
			validationErr = nil
			f.access.fail(nil)
			result = httptest.NewRecorder()
			guard.ServeHTTP(result, request)
			if result.Code != http.StatusNoContent {
				t.Fatalf("same grant after policy recovery = %d, want 204", result.Code)
			}
			if got := f.livekit.Removed(); len(got) != 0 {
				t.Fatalf("transient policy failure removed participants: %v", got)
			}
		})
	}
}

func TestGrantIdentityFallbackDoesNotEnableUnvalidatedSignalling(t *testing.T) {
	f := newFixture(bob)
	gate := &sync.Mutex{}
	f.s.ConfigureAdmission(gate, nil, "https://falky.example")
	creds, err := f.s.Join(t.Context(), bob, roomA)
	if err != nil {
		t.Fatal(err)
	}
	p := f.livekit.AddParticipant(roomA, creds.GrantID)
	gate.Lock()
	err = f.s.ValidateGrants(t.Context())
	gate.Unlock()
	if err != nil {
		t.Fatalf("ValidateGrants with identity fallback: %v", err)
	}
	if err := f.s.Refresh(t.Context()); err != nil {
		t.Fatalf("Refresh with identity fallback: %v", err)
	}
	wantOccupancy(t, f.s, roomA, bob)
	result := httptest.NewRecorder()
	f.s.Signalling("http://127.0.0.1:1").ServeHTTP(result, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/rtc/validate?access_token="+creds.Token, nil))
	if result.Code != http.StatusServiceUnavailable {
		t.Fatalf("signalling without session validation = %d, want 503", result.Code)
	}
	if got := f.livekit.Removed(); len(got) != 0 {
		t.Fatalf("identity fallback removed participant %v: %v", p, got)
	}
}

func TestAccountSessionsKeepIndependentConnections(t *testing.T) {
	s, lk := newService(8)
	first := identity.Session{Visitor: bob, ID: "first", Kind: identity.Account, Generation: 1}
	second := first
	second.ID = "second"
	var identities []string
	for _, session := range []identity.Session{first, first, second} {
		creds, err := s.JoinSession(t.Context(), session, roomA)
		if err != nil {
			t.Fatal(err)
		}
		id := decodeTokenIdentity(t, creds.Token)
		for _, old := range identities {
			if old == id {
				t.Fatal("reused transport")
			}
		}
		identities = append(identities, id)
		lk.AddParticipant(roomA, id)
	}
	if listed, _ := lk.Participants(t.Context()); len(listed) != 3 {
		t.Fatalf("independent participants = %v", listed)
	}
}

func decodeTokenIdentity(t *testing.T, token string) string {
	t.Helper()
	grants, _ := decodeToken(t, token)
	return grants.Identity
}
