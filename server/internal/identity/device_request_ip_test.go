package identity_test

import (
	"database/sql"
	"io"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

func TestRequesterIPMigrationPreservesExistingRequests(t *testing.T) {
	legacy := fstest.MapFS{}
	entries, err := fs.ReadDir(identity.Migrations(), ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "0016" {
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
	if err := db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), `INSERT INTO account_signin_requests(id,type,state,requester_user_agent,created_at,expires_at) VALUES('legacy','qr','cancelled','Original browser',100,400)`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	all, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if applied, err := db.Migrate(t.Context(), all); err != nil || applied != 1 {
		t.Fatalf("migration=%d, %v", applied, err)
	}
	var ip, agent, state string
	if err := db.Read().QueryRowContext(t.Context(), `SELECT requester_ip,requester_user_agent,state FROM account_signin_requests WHERE id='legacy'`).Scan(&ip, &agent, &state); err != nil {
		t.Fatal(err)
	}
	if ip != "" || agent != "Original browser" || state != "cancelled" {
		t.Fatalf("request changed: %q %q %q", ip, agent, state)
	}
}

func TestSignInRequesterIPPersistsWithoutChangingOnResume(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, _ := enroll(t, f, "Alice")
	link, _, err := f.ident.CreateSignInLink(t.Context(), account.Token)
	if err != nil {
		t.Fatal(err)
	}
	begin, _, err := f.ident.BeginSignInRequest(t.Context(), link.Token, "", "", "iPhone", "2001:db8::42")
	if err != nil {
		t.Fatal(err)
	}
	resume, _, err := f.ident.BeginSignInRequest(t.Context(), link.Token, begin.BrowserSecret, "", "Changed", "203.0.113.1")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := f.ident.SignInLink(t.Context(), account.Token, link.Link.ID)
	if err != nil {
		t.Fatal(err)
	}
	if begin.Request.RequesterIP != "2001:db8::42" || resume.Request.RequesterIP != begin.Request.RequesterIP || len(stored.Requests) != 1 || stored.Requests[0].RequesterIP != begin.Request.RequesterIP {
		t.Fatalf("begin=%+v resume=%+v stored=%+v", begin.Request, resume.Request, stored.Requests)
	}
}

func TestQRRequesterIPValidation(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"::ffff:203.0.113.42", "203.0.113.42"},
		{"2001:db8::42", "2001:db8::42"},
		{"not an IP", ""},
		{"", ""},
	} {
		t.Run(tc.input, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			begin, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "Browser", false, nil, tc.input)
			if err != nil {
				t.Fatal(err)
			}
			if begin.Request.RequesterIP != tc.want {
				t.Fatalf("IP=%q want=%q", begin.Request.RequesterIP, tc.want)
			}
		})
	}
}
