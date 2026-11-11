package identity_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestDeviceMaintenanceWipesSecretsRetainsSuccessAndPrunesStaleSessions(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, _ := enroll(t, f, "Alice")
	link, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
	if err != nil {
		t.Fatal(err)
	}
	pending, _, err := f.ident.BeginSignInRequest(t.Context(), link.Token, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	success, _, err := f.ident.BeginSignInRequest(t.Context(), link.Token, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.ident.ApproveSignInLink(t.Context(), a.Token, link.Link.ID, success.Code); err != nil {
		t.Fatal(err)
	}
	finish, err := f.ident.FinishSignInRequest(t.Context(), success.Request.ID, success.BrowserSecret, link.Token, "")
	if err != nil {
		t.Fatal(err)
	}
	qr, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(identity.SignInTTL)
	if _, err = f.ident.SignInRequest(t.Context(), qr.Request.ID, qr.BrowserSecret); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("deadline depends on cleanup", err)
	}
	effects, err := f.ident.MaintainSignIns(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range effects.SignInChanges {
		if c.Request.ID == qr.Request.ID && c.Request.State == "cancelled" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no pruned request terminal snapshot: %+v", effects)
	}
	var requests, links, secrets, violations int
	if err = f.db.Read().QueryRowContext(t.Context(), "SELECT count(*),count(browser_token_hash)+count(code)+count(qr_token_hash)+count(delivery_ciphertext) FROM account_signin_requests").Scan(&requests, &secrets); err != nil {
		t.Fatal(err)
	}
	if requests != 3 || secrets != 0 {
		t.Fatalf("retention requests=%d secrets=%d", requests, secrets)
	}
	if err = f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM account_signin_links WHERE token_hash IS NULL").Scan(&links); err != nil || links != 1 {
		t.Fatalf("link retained=%d %v", links, err)
	}
	if _, err = f.ident.SignInRequest(t.Context(), pending.Request.ID, pending.BrowserSecret); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal(err)
	}
	if _, err = f.ident.ResolveSession(t.Context(), finish.Token); err != nil {
		t.Fatal(err)
	}
	if err = f.db.Write(t.Context(), func(tx *sql.Tx) error {
		for _, table := range []string{"account_signin_requests", "account_signin_links"} {
			if _, err := tx.ExecContext(t.Context(), "CREATE TRIGGER reject_repeated_"+table+" BEFORE UPDATE ON "+table+" BEGIN SELECT RAISE(ABORT,'cleared history updated'); END"); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	repeated, err := f.ident.MaintainSignIns(t.Context())
	if err != nil || len(repeated.SignInChanges) != 0 {
		t.Fatalf("repeated maintenance=%+v %v", repeated, err)
	}
	if err = f.db.Write(t.Context(), func(tx *sql.Tx) error {
		for _, table := range []string{"account_signin_requests", "account_signin_links"} {
			if _, err := tx.ExecContext(t.Context(), "DROP TRIGGER reject_repeated_"+table); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = f.ident.PurgeSignIns(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err = f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM account_signin_requests").Scan(&requests); err != nil || requests != 1 {
		t.Fatalf("purge retained requests=%d %v", requests, err)
	}
	if err = f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM account_signin_links").Scan(&links); err != nil || links != 1 {
		t.Fatalf("purge removed successful parent: links=%d %v", links, err)
	}
	// Generation changes can be persisted before startup maintenance runs.
	if err = f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "UPDATE accounts SET generation=generation+1 WHERE identity_id=?", a.Session.Visitor.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	effects, err = f.ident.MaintainSignIns(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(effects.RevokedSessions) != 2 {
		t.Fatalf("stale sessions=%+v", effects.RevokedSessions)
	}
	if err = f.ident.PurgeSignIns(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"SELECT count(*) FROM sessions", "SELECT count(*) FROM account_signin_requests", "SELECT count(*) FROM account_signin_links", "SELECT count(*) FROM session_authentications", "SELECT count(*) FROM pragma_foreign_key_check"} {
		if err = f.db.Read().QueryRowContext(t.Context(), query).Scan(&violations); err != nil || violations != 0 {
			t.Fatalf("%s: %d %v", query, violations, err)
		}
	}
	if _, err = f.ident.MaintainSignIns(t.Context()); err != nil {
		t.Fatal("not retryable", err)
	}
}

func TestDeviceMaintenancePrunesExpiredAndRotatedGuestSessionsAndRetriesFailure(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	_, oldGuest := f.enter(t, "Old guest")
	old, err := f.ident.ResolveSession(t.Context(), oldGuest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.ident.Rotate(t.Context()); err != nil {
		t.Fatal(err)
	}
	link, err := f.ident.Link(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	f.secret = strings.TrimPrefix(link, "https://falky.example/#k=")
	_, newGuest := f.enter(t, "New guest")
	account, _ := enroll(t, f, "Alice")
	if err = f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "UPDATE sessions SET created_at=created_at-2,expires_at=? WHERE id=?", f.clock.Now().Unix(), account.Session.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	qr, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(identity.SignInTTL)
	if err = f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "CREATE TRIGGER fail_cleanup BEFORE UPDATE OF browser_token_hash ON account_signin_requests BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	effects, err := f.ident.MaintainSignIns(t.Context())
	if err == nil || len(effects.RevokedSessions) != 0 || len(effects.SignInChanges) != 0 {
		t.Fatalf("failed cleanup published effects=%+v %v", effects, err)
	}
	var state string
	if err = f.db.Read().QueryRowContext(t.Context(), "SELECT state FROM account_signin_requests WHERE id=?", qr.Request.ID).Scan(&state); err != nil || state != "pending" {
		t.Fatalf("partial cleanup committed=%s %v", state, err)
	}
	if err = f.db.Write(t.Context(), func(tx *sql.Tx) error { _, err := tx.ExecContext(t.Context(), "DROP TRIGGER fail_cleanup"); return err }); err != nil {
		t.Fatal(err)
	}
	effects, err = f.ident.MaintainSignIns(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	revoked := map[string]bool{}
	for _, session := range effects.RevokedSessions {
		revoked[session.ID] = true
	}
	if len(revoked) != 2 || !revoked[old.ID] || !revoked[account.Session.ID] {
		t.Fatalf("cleanup revocations=%+v", revoked)
	}
	if _, err = f.ident.ResolveSession(t.Context(), newGuest); err != nil {
		t.Fatal("current guest pruned", err)
	}
}

func TestDeviceMaintenanceEmitsOneTerminalHintPerExpiringLinkRequest(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, _ := enroll(t, f, "Account")
	link, _, err := f.ident.CreateSignInLink(t.Context(), account.Token)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, _, err = f.ident.BeginSignInRequest(t.Context(), link.Token, "", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	f.clock.Advance(identity.SignInTTL)
	effects, err := f.ident.MaintainSignIns(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool)
	for _, change := range effects.SignInChanges {
		if seen[change.Request.ID] || change.Request.State != "cancelled" || change.Request.Version != 2 {
			t.Fatalf("duplicate or invalid terminal hint: %+v", change)
		}
		seen[change.Request.ID] = true
	}
	if len(seen) != 3 {
		t.Fatalf("terminal requests=%d", len(seen))
	}
}

func TestDevicePurgeBatchesRetriesAndWaitsForSanitization(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	for range 300 {
		if _, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil); err != nil {
			t.Fatal(err)
		}
	}
	count := func() int {
		t.Helper()
		var n int
		if err := f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM account_signin_requests").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	f.clock.Advance(identity.SignInTTL)
	if err := f.ident.PurgeSignIns(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := count(); got != 300 {
		t.Fatalf("unsanitized requests purged: %d", got)
	}
	if _, err := f.ident.MaintainSignIns(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := f.ident.PurgeSignIns(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled purge: %v", err)
	}
	if got := count(); got != 300 {
		t.Fatalf("cancelled purge changed data: %d", got)
	}
	if err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "CREATE TRIGGER interrupt_purge BEFORE DELETE ON account_signin_requests WHEN (SELECT count(*) FROM account_signin_requests)<100 BEGIN SELECT RAISE(ABORT,'interrupted purge'); END")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.ident.PurgeSignIns(t.Context()); err == nil {
		t.Fatal("purge ignored interruption")
	}
	if got := count(); got >= 300 || got < 100 {
		t.Fatalf("purge did not commit bounded batches: %d", got)
	}
	if err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "DROP TRIGGER interrupt_purge")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.ident.PurgeSignIns(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := count(); got != 0 {
		t.Fatalf("retry left %d requests", got)
	}
}
