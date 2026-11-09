package voice_test

import (
	"errors"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/voice"
)

func TestAccountVoiceRequiresConfirmedSessionTransfer(t *testing.T) {
	s, lk := newService(8)
	first := identity.Session{Visitor: bob, ID: "first", Kind: identity.Account, Generation: 1}
	second := first
	second.ID = "second"
	one, err := s.JoinSession(t.Context(), first, roomA, false)
	if err != nil {
		t.Fatal(err)
	}
	oldIdentity := decodeTokenIdentity(t, one.Token)
	lk.AddParticipant(roomA, oldIdentity)
	if _, err := s.JoinSession(t.Context(), second, roomA, false); !errors.Is(err, voice.ErrTransferRequired) {
		t.Fatalf("unconfirmed second-session join = %v, want transfer required", err)
	}
	if listed, _ := lk.Participants(t.Context()); len(listed) != 1 || listed[0].Identity != oldIdentity {
		t.Fatalf("unconfirmed join displaced first participant: %v", listed)
	}
	two, err := s.JoinSession(t.Context(), second, roomA, true)
	if err != nil {
		t.Fatal(err)
	}
	if decodeTokenIdentity(t, two.Token) == oldIdentity {
		t.Fatal("transfer reused stale transport identity")
	}
	if listed, _ := lk.Participants(t.Context()); len(listed) != 0 {
		t.Fatalf("old participant remains: %v", listed)
	}
}

func decodeTokenIdentity(t *testing.T, token string) string {
	t.Helper()
	grants, _ := decodeToken(t, token)
	return grants.Identity
}
