package identity_test

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestDeviceBudgetCooldownAndStateSurviveRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	f := newFixture(t, path)
	a, _ := enroll(t, f, "Alice")
	l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
	if err != nil {
		t.Fatal(err)
	}
	begin, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for range 4 {
		if _, _, err = f.ident.ApproveSignInLink(t.Context(), a.Token, l.Link.ID, "wrong"); !errors.Is(err, identity.ErrInvalidProof) {
			t.Fatal(err)
		}
	}
	if err = f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.db = openDB(t, path)
	f.ident = identity.New(f.db, "https://falky.example", identity.WithClock(f.clock.Now))
	resume, changes, err := f.ident.BeginSignInRequest(t.Context(), l.Token, begin.BrowserSecret, "", "")
	if err != nil || resume.Code != begin.Code || resume.Request.ID != begin.Request.ID || len(changes.SignInChanges) != 0 {
		t.Fatalf("resume=%+v %v", resume, err)
	}
	var cooldown *identity.SignInCooldownError
	if _, err = f.ident.ResendSignInRequest(t.Context(), second.Request.ID, second.BrowserSecret, l.Token); !errors.As(err, &cooldown) || cooldown.RetryAfter != 10*time.Second {
		t.Fatalf("cooldown=%+v %v", cooldown, err)
	}
	f.clock.Advance(10 * time.Second)
	effects, err := f.ident.ResendSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, l.Token)
	if err != nil || len(effects.SignInChanges) != 1 || effects.SignInChanges[0].Request.Version != 1 {
		t.Fatalf("resend=%+v %v", effects, err)
	}
	_, effects, err = f.ident.ApproveSignInLink(t.Context(), a.Token, l.Link.ID, "wrong")
	if !errors.Is(err, identity.ErrInvalidProof) || len(effects.SignInChanges) != 2 {
		t.Fatalf("fifth attempt=%+v %v", effects, err)
	}
	status, err := f.ident.SignInLink(t.Context(), a.Token, l.Link.ID)
	if err != nil || status.State != "revoked" || status.Version != 2 {
		t.Fatalf("status=%+v %v", status, err)
	}
	var attempts int
	if err = f.db.Read().QueryRowContext(t.Context(), "SELECT failed_code_attempts FROM account_signin_links WHERE id=?", l.Link.ID).Scan(&attempts); err != nil || attempts != 5 {
		t.Fatalf("attempts=%d %v", attempts, err)
	}
	if _, _, err = f.ident.BeginSignInRequest(t.Context(), l.Token, begin.BrowserSecret, "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal(err)
	}
}

func TestDeviceQRApprovedAndEncryptedDeliverySurviveRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	f := newFixture(t, path)
	a, _ := enroll(t, f, "Alice")
	q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, q.QRToken); err != nil {
		t.Fatal(err)
	}
	reopen := func() {
		t.Helper()
		if err := f.db.Close(); err != nil {
			t.Fatal(err)
		}
		f.db = openDB(t, path)
		f.ident = identity.New(f.db, "https://falky.example", identity.WithClock(f.clock.Now))
	}
	reopen()
	resume, _, err := f.ident.BeginQRSignIn(t.Context(), q.BrowserSecret, "", "", false, func(string) error { t.Fatal("resume allocated"); return nil })
	if err != nil || resume.QRToken != q.QRToken || resume.Request.State != "approved" || !resume.Request.ExpiresAt.Equal(q.Request.ExpiresAt) {
		t.Fatalf("resume=%+v %v", resume, err)
	}
	finish, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", "")
	if err != nil {
		t.Fatal(err)
	}
	reopen()
	retry, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", "")
	if err != nil || retry.Token != finish.Token || retry.Session != finish.Session {
		t.Fatalf("retry=%+v %v", retry, err)
	}
	f.clock.Advance(identity.SignInTTL)
	if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("restart extended deadline", err)
	}
}

func TestDeviceExpiredConsumedQRExplicitReplaceConflictsButNewFlowCanBegin(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, _ := enroll(t, f, "Alice")
	q, _ := deviceQR(t, f, a.Token)
	f.clock.Advance(identity.SignInTTL)
	allocations := 0
	allocate := func(string) error { allocations++; return nil }
	if _, _, err := f.ident.BeginQRSignIn(t.Context(), q.BrowserSecret, "", "", true, allocate); !errors.Is(err, identity.ErrSignInConflict) {
		t.Fatalf("replaced expired successful metadata: %v", err)
	}
	if allocations != 0 {
		t.Fatal("consumed replacement charged allocation")
	}
	next, _, err := f.ident.BeginQRSignIn(t.Context(), q.BrowserSecret, "", "", false, allocate)
	if err != nil || next.Request.ID == q.Request.ID || allocations != 1 {
		t.Fatalf("new flow=%+v allocations=%d %v", next, allocations, err)
	}
}
