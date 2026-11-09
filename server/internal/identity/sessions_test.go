package identity_test

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestGuestSessionHasIndependentIDAndFourHundredDayAbsoluteExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "guest.db")
	f := newFixture(t, path)
	guest, token := f.enter(t, "Guest")
	issued, err := f.ident.ResolveSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	if issued.ID == "" || issued.ID == token || issued.Kind != identity.Guest || !issued.ExpiresAt.Equal(f.clock.Now().Add(identity.GuestSessionTTL)) {
		t.Fatalf("guest session = %+v", issued)
	}
	if _, err := f.ident.ResolveSession(t.Context(), issued.ID); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("public session ID acted as cookie token: %v", err)
	}
	restarted := identity.New(openDB(t, path), "https://falky.example", identity.WithClock(f.clock.Now))
	restored, err := restarted.ResolveSession(t.Context(), token)
	if err != nil || restored != issued {
		t.Fatalf("restarted session = %+v, %v; want %+v", restored, err, issued)
	}
	f.clock.Advance(identity.GuestSessionTTL - time.Second)
	used, err := f.ident.ResolveSession(t.Context(), token)
	if err != nil || used != issued {
		t.Fatalf("session renewed or expired early: %+v, %v", used, err)
	}
	f.clock.Advance(time.Second)
	for _, service := range []*identity.Service{f.ident, restarted} {
		if _, err := service.ResolveSession(t.Context(), token); !errors.Is(err, identity.ErrNoVisitor) {
			t.Fatalf("retained cookie survived absolute expiry: %v", err)
		}
		if _, err := service.ValidateSession(t.Context(), issued); !errors.Is(err, identity.ErrNoVisitor) {
			t.Fatalf("authorization snapshot survived expiry: %v", err)
		}
		if _, err := service.GuestSession(t.Context(), guest.ID); !errors.Is(err, identity.ErrNoVisitor) {
			t.Fatalf("transport lookup restored expired access: %v", err)
		}
	}
	colours, err := f.ident.Colours(t.Context(), []string{guest.ID})
	if err != nil || len(colours) != 1 || colours[0] != guest.Colour {
		t.Fatalf("session expiry removed historical appearance: %+v, %v", colours, err)
	}
}

func TestSessionConstraintsProtectAccountOwnershipAndRecentProof(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "sessions.db"))
	guest, _ := f.enter(t, "Guest")
	account, _ := enroll(t, f, "Account")
	now := f.clock.Now().Unix()
	for _, tt := range []struct {
		name       string
		identityID string
		accountID  any
		proofAt    any
		credential any
		expiry     int64
	}{
		{"missing account", guest.ID, guest.ID, nil, nil, now + 60},
		{"another identity's account", guest.ID, account.Session.Visitor.ID, nil, nil, now + 60},
		{"guest proof", guest.ID, nil, now, []byte("credential"), now + 60},
		{"incomplete proof", account.Session.Visitor.ID, account.Session.Visitor.ID, now, nil, now + 60},
		{"nonpositive lifetime", guest.ID, nil, nil, nil, now},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
				_, err := tx.ExecContext(t.Context(), `INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at,proof_at,proof_credential)
                    VALUES('invalid',?,?,?,?,?,?,?,?)`, make([]byte, 32), tt.identityID, tt.accountID, 1, now, tt.expiry, tt.proofAt, tt.credential)
				return err
			})
			if err == nil {
				t.Fatal("database accepted invalid session")
			}
		})
	}
}
