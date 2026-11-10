package identity_test

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

func TestMigrationsKeepAccountSessionsAndLeaveGuestsOnlyTheirUpgrade(t *testing.T) {
	for _, renamed := range []bool{false, true} {
		name := "before_identity_rename"
		if renamed {
			name = "after_identity_rename"
		}
		t.Run(name, func(t *testing.T) {
			legacy := fstest.MapFS{}
			for _, name := range []string{"0001_access.sql", "0002_visitors.sql", "0005_visitor_colours.sql", "0007_accounts.sql"} {
				body, err := fs.ReadFile(identity.Migrations(), name)
				if err != nil {
					t.Fatal(err)
				}
				legacy[name] = &fstest.MapFile{Data: body}
			}
			ms, err := platform.LoadMigrations(legacy)
			if err != nil {
				t.Fatal(err)
			}
			db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "falky.db"), platform.NewLogger(io.Discard, 0))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			})
			if _, err := db.Migrate(t.Context(), ms); err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
			guestHash := sha256.Sum256([]byte("guest-cookie"))
			expiredHash := sha256.Sum256([]byte("expired-cookie"))
			accountHash := sha256.Sum256([]byte("account-cookie"))
			credential := []byte("credential")
			if err := db.Write(t.Context(), func(tx *sql.Tx) error {
				for _, stmt := range []struct {
					query string
					args  []any
				}{
					{"INSERT INTO access VALUES(1,'shared-link',3,'2026-11-09')", nil},
					{"INSERT INTO visitors VALUES('guest','Guest','2026-11-09'),('account','Alice','2026-11-09'),('expired','Expired','2020-01-01')", nil},
					{"INSERT INTO visitor_colours VALUES('guest','sky',7),('account','ruby',4),('expired','moss',1)", nil},
					{"INSERT INTO visitor_tokens VALUES(?,'guest',3,'2026-11-09')", []any{guestHash[:]}},
					{"INSERT INTO visitor_tokens VALUES(?,'expired',3,'2020-01-01')", []any{expiredHash[:]}},
					{"INSERT INTO accounts VALUES('account',?,0,2,?)", []any{identity.NameKey("Alice"), now.Unix()}},
					{"INSERT INTO passkeys VALUES(?,'account','Laptop','{}',?)", []any{credential, now.Unix()}},
					{"INSERT INTO account_sessions VALUES('session',?,'account',2,?,?,?)", []any{accountHash[:], now.Add(identity.AccountSessionTTL).Unix(), now.Unix(), credential}},
					{"INSERT INTO account_recovery_proofs VALUES(?,'account','code',2,NULL)", []any{[]byte("recovery-hash")}},
					{"INSERT INTO account_ceremonies VALUES('ceremony',?,'reauthenticate','account','session','Alice',NULL,'{}',?)", []any{[]byte("context-hash"), now.Add(5 * time.Minute).Unix()}},
				} {
					if _, err := tx.ExecContext(t.Context(), stmt.query, stmt.args...); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			expected := 3
			if renamed {
				body, err := fs.ReadFile(identity.Migrations(), "0008_identity_profiles.sql")
				if err != nil {
					t.Fatal(err)
				}
				legacy["0008_identity_profiles.sql"] = &fstest.MapFile{Data: body}
				intermediate, err := platform.LoadMigrations(legacy)
				if err != nil {
					t.Fatal(err)
				}
				if applied, err := db.Migrate(t.Context(), intermediate); err != nil || applied != 1 {
					t.Fatalf("identity rename = %d, %v", applied, err)
				}
				expected = 2
			}
			all, err := platform.LoadMigrations(identity.Migrations())
			if err != nil {
				t.Fatal(err)
			}
			if applied, err := db.Migrate(t.Context(), all); err != nil || applied != expected {
				t.Fatalf("identity/session migrations = %d, %v; want %d migrations", applied, err, expected)
			}
			if applied, err := db.Migrate(t.Context(), all); err != nil || applied != 0 {
				t.Fatalf("repeated migration = %d, %v; want no changes", applied, err)
			}
			service := identity.New(db, "https://falky.example", identity.WithClock(func() time.Time { return now }))
			got, err := service.ResolveSession(t.Context(), "account-cookie")
			if err != nil {
				t.Fatal(err)
			}
			if got.Visitor.ID != "account" || got.Visitor.Name != "Alice" || got.Kind != identity.Account || got.Visitor.Colour.Palette != "ruby" || got.Visitor.Colour.Revision != 4 {
				t.Fatalf("account session after migration = %+v", got)
			}
			if got.ID != "session" || !got.ExpiresAt.Equal(now.Add(identity.AccountSessionTTL)) {
				t.Fatalf("account session ID/lifetime changed: %+v", got)
			}
			if _, err := service.ValidateSession(t.Context(), got); err != nil {
				t.Fatal(err)
			}
			if _, err := service.ResolveSession(t.Context(), "guest-cookie"); !errors.Is(err, identity.ErrNoVisitor) {
				t.Fatalf("a guest session still admits after migration: %v", err)
			}
			guest, err := service.LegacyGuest(t.Context(), "guest-cookie")
			if err != nil || guest.ID != "guest" || guest.Name != "Guest" || guest.Colour.Palette != "sky" {
				t.Fatalf("legacy guest after migration = %+v, %v", guest, err)
			}
			if _, err := service.LegacyGuest(t.Context(), "expired-cookie"); !errors.Is(err, identity.ErrNoVisitor) {
				t.Fatalf("migration revived an already expired guest: %v", err)
			}
			accounts, err := service.Accounts(t.Context())
			if err != nil || len(accounts) != 1 || accounts[0].Login != "" {
				t.Fatalf("accounts after migration = %+v, %v; want Alice without a login until she recovers", accounts, err)
			}
			var accountCount, oldTables, oldColumns, violations int
			for _, check := range []struct {
				query string
				value *int
			}{
				{"SELECT count(*) FROM accounts WHERE identity_id='guest'", &accountCount},
				{"SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('visitors','visitor_colours','visitor_tokens','account_sessions','passkeys','account_ceremonies','account_invitations')", &oldTables},
				{"SELECT count(*) FROM sqlite_schema s JOIN pragma_table_info(s.name) p WHERE s.type='table' AND p.name='visitor_id'", &oldColumns},
				{"SELECT count(*) FROM pragma_foreign_key_check", &violations},
			} {
				if err := db.Read().QueryRowContext(t.Context(), check.query).Scan(check.value); err != nil {
					t.Fatal(err)
				}
			}
			if accountCount != 0 || oldTables != 0 || oldColumns != 0 || violations != 0 {
				t.Fatalf("guest accounts=%d, old tables=%d, old columns=%d, FK violations=%d; want all zero", accountCount, oldTables, oldColumns, violations)
			}
			if err := db.Write(t.Context(), func(tx *sql.Tx) error {
				_, err := tx.ExecContext(t.Context(), "INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at) VALUES('invalid',?,'guest','guest',3,?,?)", make([]byte, 32), now.Unix(), now.Add(time.Hour).Unix())
				return err
			}); err == nil {
				t.Fatal("account session accepted an identity without an account")
			}
		})
	}
}
