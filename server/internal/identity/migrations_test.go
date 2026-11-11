package identity_test

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

func TestIdentityAndSessionMigrationsPreserveGuestsAndResetAccountAccess(t *testing.T) {
	for _, name := range []string{"before_identity_rename", "after_identity_rename", "after_sessions"} {
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
					{"INSERT INTO account_ceremonies VALUES('ceremony',?,'reauthenticate','account','session','Alice',NULL,'{}',?)", []any{[]byte("context-hash"), now.Add(identity.CeremonyTTL).Unix()}},
				} {
					if _, err := tx.ExecContext(t.Context(), stmt.query, stmt.args...); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			expected := 5
			if name != "before_identity_rename" {
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
				expected = 4
			}
			var beforeID string
			var beforeHash []byte
			var beforeGeneration, beforeCreated, beforeExpiry int64
			if name == "after_sessions" {
				body, err := fs.ReadFile(identity.Migrations(), "0009_sessions.sql")
				if err != nil {
					t.Fatal(err)
				}
				legacy["0009_sessions.sql"] = &fstest.MapFile{Data: body}
				intermediate, err := platform.LoadMigrations(legacy)
				if err != nil {
					t.Fatal(err)
				}
				if applied, err := db.Migrate(t.Context(), intermediate); err != nil || applied != 1 {
					t.Fatalf("sessions migration=%d,%v", applied, err)
				}
				if err := db.Read().QueryRowContext(t.Context(), "SELECT id,token_hash,generation,created_at,expires_at FROM sessions WHERE identity_id='guest'").Scan(&beforeID, &beforeHash, &beforeGeneration, &beforeCreated, &beforeExpiry); err != nil {
					t.Fatal(err)
				}
				expected = 3
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
			if name == "after_sessions" {
				var id string
				var hash []byte
				var generation, created, expiry int64
				if err := db.Read().QueryRowContext(t.Context(), "SELECT id,token_hash,generation,created_at,expires_at FROM sessions WHERE identity_id='guest'").Scan(&id, &hash, &generation, &created, &expiry); err != nil {
					t.Fatal(err)
				}
				if id != beforeID || !bytes.Equal(hash, beforeHash) || generation != beforeGeneration || created != beforeCreated || expiry != beforeExpiry {
					t.Fatal("0013 changed guest's exact persisted access")
				}
			}
			service := identity.New(db, "https://falky.example", identity.WithClock(func() time.Time { return now }))
			for _, want := range []struct {
				token, id, name, palette string
				kind                     identity.Kind
				revision                 int64
			}{
				{"guest-cookie", "guest", "Guest", "sky", identity.Guest, 7},
			} {
				got, err := service.ResolveSession(t.Context(), want.token)
				if err != nil {
					t.Fatal(err)
				}
				if got.Visitor.ID != want.id || got.Visitor.Name != want.name || got.Kind != want.kind || got.Visitor.Colour.Palette != want.palette || got.Visitor.Colour.Revision != want.revision {
					t.Fatalf("session after rename = %+v; want %+v", got, want)
				}
				if _, err := service.ValidateSession(t.Context(), got); err != nil {
					t.Fatal(err)
				}
				if want.kind == identity.Account && (got.ID != "session" || !got.ExpiresAt.Equal(now.Add(identity.AccountSessionTTL))) {
					t.Fatalf("account session ID/lifetime changed: %+v", got)
				}
				if want.kind == identity.Guest && !got.ExpiresAt.Equal(time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC).Add(identity.GuestSessionTTL)) {
					t.Fatalf("guest lifetime reset at migration: %+v", got)
				}
			}
			if _, err := service.ResolveSession(t.Context(), "expired-cookie"); !errors.Is(err, identity.ErrNoVisitor) {
				t.Fatalf("migration revived an already expired guest: %v", err)
			}
			if _, err := service.ResolveSession(t.Context(), "account-cookie"); !errors.Is(err, identity.ErrNoVisitor) {
				t.Fatalf("legacy account session survived: %v", err)
			}
			var passkeys, proofs, events int
			for _, check := range []struct {
				query string
				dst   *int
			}{
				{"SELECT count(*) FROM passkeys WHERE identity_id='account'", &passkeys},
				{"SELECT count(*) FROM account_recovery_proofs WHERE identity_id='account'", &proofs},
				{"SELECT count(*) FROM sessions t JOIN session_authentications e ON e.session_id=t.id WHERE e.method='guest_link' AND e.purpose='sign_in' AND e.authenticated_at=t.created_at AND e.recent_proof=0", &events},
			} {
				if err := db.Read().QueryRowContext(t.Context(), check.query).Scan(check.dst); err != nil {
					t.Fatal(err)
				}
			}
			if passkeys != 1 || proofs != 1 || events != 2 {
				t.Fatalf("preserved passkeys=%d proofs=%d guest events=%d", passkeys, proofs, events)
			}
			var accountCount, oldTables, oldColumns, violations int
			for _, check := range []struct {
				query string
				value *int
			}{
				{"SELECT count(*) FROM accounts WHERE identity_id='guest'", &accountCount},
				{"SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('visitors','visitor_colours','visitor_tokens','account_sessions')", &oldTables},
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

func TestSessionResetPreservesPasskeysAndAllowsFreshSignedLogin(t *testing.T) {
	source := newFixture(t, filepath.Join(t.TempDir(), "source.db"))
	account, key := enroll(t, source, "Alice")
	var credential string
	if err := source.db.Read().QueryRowContext(t.Context(), "SELECT credential FROM passkeys WHERE credential_id=?", key.ID).Scan(&credential); err != nil {
		t.Fatal(err)
	}
	legacy := fstest.MapFS{}
	entries, err := fs.ReadDir(identity.Migrations(), ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "0013" {
			continue
		}
		body, err := fs.ReadFile(identity.Migrations(), entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		legacy[entry.Name()] = &fstest.MapFile{Data: body}
	}
	ms, err := platform.LoadMigrations(legacy)
	if err != nil {
		t.Fatal(err)
	}
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "upgrade.db"), platform.NewLogger(io.Discard, 0))
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
	now := source.clock.Now().Unix()
	if err := db.Write(t.Context(), func(tx *sql.Tx) error {
		for _, stmt := range []struct {
			query string
			args  []any
		}{
			{"INSERT INTO identities(id,name,created_at) VALUES(?,'Alice','2026-11-04')", []any{account.Session.Visitor.ID}},
			{"INSERT INTO profiles(identity_id,palette,revision) VALUES(?,'ruby',7)", []any{account.Session.Visitor.ID}},
			{"INSERT INTO accounts(identity_id,name_key,created_at) VALUES(?,?,?)", []any{account.Session.Visitor.ID, identity.NameKey("Alice"), now}},
			{"INSERT INTO passkeys(credential_id,identity_id,label,credential,created_at) VALUES(?,?,'Original',?,?)", []any{key.ID, account.Session.Visitor.ID, credential, now}},
			{"INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at,proof_at,proof_credential) VALUES('old',?,?,?,1,?,?,?,?)", []any{sha256Bytes("old-cookie"), account.Session.Visitor.ID, account.Session.Visitor.ID, now, now + 7776000, now, key.ID}},
		} {
			if _, err := tx.ExecContext(t.Context(), stmt.query, stmt.args...); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	all, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), all); err != nil {
		t.Fatal(err)
	}
	ident := identity.New(db, "https://falky.example", identity.WithClock(source.clock.Now))
	if _, err := ident.ResolveSession(t.Context(), "old-cookie"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("legacy token survived reset: %v", err)
	}
	login, err := ident.BeginAuthentication(t.Context(), "fresh")
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := ident.FinishAuthentication(t.Context(), login.ID, "fresh", key.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Session.Visitor.ID != account.Session.Visitor.ID || fresh.Session.Visitor.Colour.Palette != "ruby" || fresh.Session.Visitor.Colour.Revision != 7 {
		t.Fatalf("fresh sign-in lost account profile: %+v", fresh.Session)
	}
}

func sha256Bytes(token string) []byte { hash := sha256.Sum256([]byte(token)); return hash[:] }

func TestSignInIndexUpgradePreservesAlreadyMigratedAccessAndHistory(t *testing.T) {
	for _, tc := range []struct {
		firstMigration string
		applied        int
	}{{"0014", 2}, {"0015", 1}} {
		t.Run("before_"+tc.firstMigration, func(t *testing.T) {
			testSignInIndexUpgrade(t, tc.firstMigration, tc.applied)
		})
	}
}

func testSignInIndexUpgrade(t *testing.T, firstMigration string, wantApplied int) {
	t.Helper()
	legacy := fstest.MapFS{}
	entries, err := fs.ReadDir(identity.Migrations(), ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= firstMigration {
			continue
		}
		body, err := fs.ReadFile(identity.Migrations(), entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		legacy[entry.Name()] = &fstest.MapFile{Data: body}
	}
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "upgrade.db"), platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	previous, err := platform.LoadMigrations(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), previous); err != nil {
		t.Fatal(err)
	}
	c := &clock{now: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)}
	service := identity.New(db, "https://falky.example", identity.WithClock(c.Now))
	if _, err := service.EnsureLink(t.Context()); err != nil {
		t.Fatal(err)
	}
	access, err := service.Link(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	f := fixture{db: db, ident: service, clock: c, secret: strings.TrimPrefix(access, "https://falky.example/#k=")}
	_, guest := f.enter(t, "Guest")
	account, _ := enroll(t, f, "Alice")
	link, _, err := service.CreateSignInLink(t.Context(), account.Token)
	if err != nil {
		t.Fatal(err)
	}
	request, _, err := service.BeginSignInRequest(t.Context(), link.Token, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.ApproveSignInLink(t.Context(), account.Token, link.Link.ID, request.Code); err != nil {
		t.Fatal(err)
	}
	result, err := service.FinishSignInRequest(t.Context(), request.Request.ID, request.BrowserSecret, link.Token, "")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func() map[string][]string {
		t.Helper()
		out := make(map[string][]string)
		for _, table := range []string{"sessions", "session_authentications", "account_signin_links", "account_signin_requests", "passkeys"} {
			rows, err := db.Read().QueryContext(t.Context(), "SELECT * FROM "+table+" ORDER BY rowid")
			if err != nil {
				t.Fatal(err)
			}
			columns, err := rows.Columns()
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				values := make([]any, len(columns))
				pointers := make([]any, len(columns))
				for i := range values {
					pointers[i] = &values[i]
				}
				if err := rows.Scan(pointers...); err != nil {
					t.Fatal(err)
				}
				out[table] = append(out[table], fmt.Sprintf("%#v", values))
			}
			if err := errors.Join(rows.Err(), rows.Close()); err != nil {
				t.Fatal(err)
			}
		}
		return out
	}
	before := snapshot()
	all, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if applied, err := db.Migrate(t.Context(), all); err != nil || applied != wantApplied {
		t.Fatalf("index upgrade=%d %v", applied, err)
	}
	var redundantIndexes int
	if err := db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name IN ('account_signin_requests_by_expiry','session_authentications_initial_passkey','session_authentications_initial_origin')").Scan(&redundantIndexes); err != nil || redundantIndexes != 0 {
		t.Fatalf("redundant indexes=%d %v", redundantIndexes, err)
	}
	if after := snapshot(); !reflect.DeepEqual(before, after) {
		t.Fatalf("index upgrade changed access or history:\nbefore=%v\nafter=%v", before, after)
	}
	for _, token := range []string{guest, account.Token, result.Token} {
		if _, err := service.ResolveSession(t.Context(), token); err != nil {
			t.Fatal("index upgrade revoked access", err)
		}
	}
	if retry, err := service.FinishSignInRequest(t.Context(), request.Request.ID, request.BrowserSecret, link.Token, ""); err != nil || retry.Token != result.Token {
		t.Fatalf("upgrade broke redelivery: %v", err)
	}
	if applied, err := db.Migrate(t.Context(), all); err != nil || applied != 0 {
		t.Fatalf("repeated upgrade=%d %v", applied, err)
	}
}
