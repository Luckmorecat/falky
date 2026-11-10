package voice_test

import (
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

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
