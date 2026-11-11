package identity_test

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

func BenchmarkSignInIndexes(b *testing.B) {
	variants := []string{"both", "passkey_only", "origin_only", "neither"}
	if os.Getenv("SIGNIN_BENCH_REVERSE") == "1" {
		slices.Reverse(variants)
	}
	for _, size := range []struct {
		name                 string
		accounts, perAccount int
	}{
		{"small", 100, 16},
		{"many_accounts", 10000, 16},
		{"many_sessions", 100, 1600},
	} {
		b.Run(size.name, func(b *testing.B) {
			db := benchmarkSignInDB(b, size.accounts, size.perAccount)
			for _, statistics := range []string{"unanalyzed", "analyzed"} {
				b.Run(statistics, func(b *testing.B) {
					for _, indexes := range variants {
						b.Run(indexes, func(b *testing.B) {
							benchmarkSetSignInIndexes(b, db, indexes, statistics == "analyzed")
							credential := []byte("account-0-key-0")
							args := []any{"account-0", credential, credential}
							plan, err := db.Read().QueryContext(b.Context(), "EXPLAIN QUERY PLAN "+benchmarkRevokedSessions, args...)
							if err != nil {
								b.Fatal(err)
							}
							for plan.Next() {
								var id, parent, unused int
								var detail string
								if err := plan.Scan(&id, &parent, &unused, &detail); err != nil {
									b.Fatal(err)
								}
								b.Log(detail)
							}
							if err := errors.Join(plan.Err(), plan.Close()); err != nil {
								b.Fatal(err)
							}
							b.Run("revocation_lookup", func(b *testing.B) {
								for b.Loop() {
									rows, err := db.Read().QueryContext(b.Context(), benchmarkRevokedSessions, args...)
									if err != nil {
										b.Fatal(err)
									}
									count := 0
									for rows.Next() {
										var id string
										var generation, expires int64
										if err := rows.Scan(&id, &generation, &expires); err != nil {
											b.Fatal(err)
										}
										count++
									}
									if err := errors.Join(rows.Err(), rows.Close()); err != nil {
										b.Fatal(err)
									}
									if count != size.perAccount/4 {
										b.Fatalf("revoked count=%d, want %d", count, size.perAccount/4)
									}
								}
							})
							for _, operation := range []struct{ name, query string }{
								{"initial_insert", `INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,passkey_credential_id,recent_proof) VALUES('insert-bench','passkey','sign_in',1000,?,1)`},
								{"credential_delete", `DELETE FROM passkeys WHERE credential_id=?`},
							} {
								b.Run(operation.name, func(b *testing.B) {
									rollback := errors.New("restore benchmark fixture")
									for b.Loop() {
										err := db.Write(b.Context(), func(tx *sql.Tx) error {
											if _, err := tx.ExecContext(b.Context(), operation.query, credential); err != nil {
												return err
											}
											return rollback
										})
										if !errors.Is(err, rollback) {
											b.Fatal(err)
										}
									}
								})
							}
						})
					}
				})
			}
		})
	}
}

func benchmarkSignInDB(b *testing.B, accounts, perAccount int) *platform.DB {
	b.Helper()
	db, err := platform.OpenDB(b.Context(), filepath.Join(b.TempDir(), "indexes.db"), platform.NewLogger(io.Discard, 0))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		if err := db.Close(); err != nil {
			b.Error(err)
		}
	})
	migrations, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		b.Fatal(err)
	}
	if _, err := db.Migrate(b.Context(), migrations); err != nil {
		b.Fatal(err)
	}
	benchmarkSetSignInIndexes(b, db, "both", false)
	err = db.Write(b.Context(), func(tx *sql.Tx) error {
		queries := []string{
			fmt.Sprintf(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x+1<%d) INSERT INTO identities SELECT 'account-'||x,'Account '||x,'2026-11-11' FROM n`, accounts),
			`INSERT INTO accounts SELECT id,id,0,1,1000 FROM identities`,
			`WITH keys(k) AS (VALUES(0),(1),(2),(3)) INSERT INTO passkeys SELECT CAST(id||'-key-'||k AS BLOB),id,'Key','{}',1000 FROM identities CROSS JOIN keys`,
			fmt.Sprintf(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x+1<%d) INSERT INTO sessions SELECT 'session-'||x,randomblob(32),'account-'||(x/%d),'account-'||(x/%d),1,1000,7777000 FROM n`, accounts*perAccount, perAccount, perAccount),
			`INSERT INTO account_signin_requests(id,type,state,requester_user_agent,approved_by_session_id,origin_passkey_credential_id,created_at,expires_at,approved_at,consumed_at,created_session_id)
 SELECT 'request-'||id,'qr','consumed','',NULL,CAST(identity_id||'-key-'||((CAST(substr(id,9) AS INTEGER)/2)%4) AS BLOB),1000,1300,1000,1000,id FROM sessions WHERE CAST(substr(id,9) AS INTEGER)%2=1`,
			`INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,passkey_credential_id,device_approval_request_id,origin_passkey_credential_id,recent_proof)
 SELECT id,CASE WHEN CAST(substr(id,9) AS INTEGER)%2=0 THEN 'passkey' ELSE 'device_approval' END,'sign_in',1000,
 CASE WHEN CAST(substr(id,9) AS INTEGER)%2=0 THEN CAST(identity_id||'-key-'||((CAST(substr(id,9) AS INTEGER)/2)%4) AS BLOB) END,
 CASE WHEN CAST(substr(id,9) AS INTEGER)%2=1 THEN 'request-'||id END,
 CASE WHEN CAST(substr(id,9) AS INTEGER)%2=1 THEN CAST(identity_id||'-key-'||((CAST(substr(id,9) AS INTEGER)/2)%4) AS BLOB) END,
 CASE WHEN CAST(substr(id,9) AS INTEGER)%2=0 THEN 1 ELSE 0 END FROM sessions`,
			`WITH events(n) AS (VALUES(1),(2),(3)) INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,passkey_credential_id,recent_proof) SELECT id,'passkey','reauthentication',1000+n,CAST(identity_id||'-key-'||n AS BLOB),1 FROM sessions CROSS JOIN events`,
			`INSERT INTO sessions VALUES('insert-bench',randomblob(32),'account-0','account-0',1,1000,7777000)`,
		}
		for _, query := range queries {
			if _, err := tx.ExecContext(b.Context(), query); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		b.Fatal(err)
	}
	return db
}

func benchmarkSetSignInIndexes(b *testing.B, db *platform.DB, variant string, analyze bool) {
	b.Helper()
	err := db.Write(b.Context(), func(tx *sql.Tx) error {
		for _, kind := range []string{"passkey", "origin"} {
			name := "session_authentications_initial_" + kind
			if _, err := tx.ExecContext(b.Context(), "DROP INDEX IF EXISTS "+name); err != nil {
				return err
			}
			if variant == "both" || variant == kind+"_only" {
				column := "passkey_credential_id"
				if kind == "origin" {
					column = "origin_passkey_credential_id"
				}
				if _, err := tx.ExecContext(b.Context(), "CREATE INDEX "+name+" ON session_authentications("+column+") WHERE purpose='sign_in'"); err != nil {
					return err
				}
			}
		}
		if analyze {
			_, err := tx.ExecContext(b.Context(), "ANALYZE")
			return err
		}
		return nil
	})
	if err != nil {
		b.Fatal(err)
	}
}
