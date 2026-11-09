package identity_test

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestGuestSessionLookupRequiresUniqueCurrentGuestSession(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "guest.db"))
	guest, token := f.enter(t, "Guest")
	want, err := f.ident.ResolveSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	current, err := f.ident.GuestSession(t.Context(), guest.ID)
	if err != nil || current != want {
		t.Fatalf("guest session lookup = %+v, %v", current, err)
	}
	// Enter always creates a new ID; simulate ambiguous persisted state and
	// require refusal rather than guessing which cookie the JWT belongs to.
	if err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), `INSERT INTO sessions(id,token_hash,identity_id,generation,created_at,expires_at)
			SELECT 'ambiguous',?,identity_id,generation,created_at,expires_at FROM sessions WHERE identity_id=?`, make([]byte, 32), guest.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.GuestSession(t.Context(), guest.ID); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("ambiguous guest lookup = %v", err)
	}
}
