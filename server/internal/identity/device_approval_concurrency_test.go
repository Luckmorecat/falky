package identity_test

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestDeviceConcurrentLinkBeginHasThreeSlotsAndOneActiveLink(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, _ := enroll(t, f, "Alice")
	l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for range 12 {
		wg.Go(func() { _, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", ""); errs <- err })
	}
	wg.Wait()
	close(errs)
	success := 0
	for err := range errs {
		if err == nil {
			success++
		} else if !errors.Is(err, identity.ErrSignInPendingCap) {
			t.Fatal(err)
		}
	}
	if success != 3 {
		t.Fatalf("pending allocations=%d", success)
	}
	errs = make(chan error, 5)
	for range 5 {
		wg.Go(func() { _, _, err := f.ident.CreateSignInLink(t.Context(), a.Token); errs <- err })
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	links, err := f.ident.SignInLinks(t.Context(), a.Token)
	if err != nil {
		t.Fatal(err)
	}
	active := 0
	for _, link := range links {
		if link.State == "open" || link.State == "approved" {
			active++
		}
	}
	if active != 1 {
		t.Fatalf("active links=%d", active)
	}
}

func TestDeviceConcurrentQRAccountSelectionAndFinishHaveOneWinner(t *testing.T) {
	for _, flow := range []string{"link", "qr"} {
		t.Run(flow, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			a, _ := enroll(t, f, "Alice")
			b, _ := enroll(t, f, "Bob")
			var q identity.SignInBeginResult
			var linkToken string
			var err error
			if flow == "link" {
				l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
				if err != nil {
					t.Fatal(err)
				}
				linkToken = l.Token
				q, _, err = f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", "")
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveSignInLink(t.Context(), a.Token, l.Link.ID, q.Code); err != nil {
					t.Fatal(err)
				}
			} else {
				q, _, err = f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
				if err != nil {
					t.Fatal(err)
				}
				var wg sync.WaitGroup
				errs := make(chan error, 2)
				for _, token := range []string{a.Token, b.Token} {
					wg.Go(func() { _, _, err := f.ident.ApproveQRSignIn(t.Context(), token, q.QRToken); errs <- err })
				}
				wg.Wait()
				close(errs)
				wins := 0
				for err := range errs {
					if err == nil {
						wins++
					} else if !errors.Is(err, identity.ErrSignInConflict) {
						t.Fatal(err)
					}
				}
				if wins != 1 {
					t.Fatalf("account selection wins=%d", wins)
				}
			}
			type delivery struct {
				finish identity.SignInFinish
				err    error
			}
			results := make(chan delivery, 16)
			var wg sync.WaitGroup
			for range 16 {
				wg.Go(func() {
					r, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, linkToken, "")
					results <- delivery{r, err}
				})
			}
			wg.Wait()
			close(results)
			session, token := "", ""
			for r := range results {
				if r.err != nil {
					t.Fatal(r.err)
				}
				if session == "" {
					session, token = r.finish.Session.ID, r.finish.Token
				}
				if r.finish.Session.ID != session || r.finish.Token != token {
					t.Fatal("multiple sessions")
				}
			}
			var events, sessions int
			if err = f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM session_authentications WHERE device_approval_request_id=?", q.Request.ID).Scan(&events); err != nil {
				t.Fatal(err)
			}
			if err = f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM sessions").Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			if events != 1 || sessions != 3 {
				t.Fatalf("events=%d sessions=%d", events, sessions)
			}
		})
	}
}

func TestDeviceApproverLogoutRacingFinishLeavesNoUnredeemedAuthorization(t *testing.T) {
	for range 8 {
		f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
		a, _ := enroll(t, f, "Alice")
		q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, q.QRToken); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		var finish identity.SignInFinish
		var finishErr, logoutErr error
		wg.Go(func() {
			finish, finishErr = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", "")
		})
		wg.Go(func() { _, logoutErr = f.ident.Logout(t.Context(), a.Token) })
		wg.Wait()
		if logoutErr != nil {
			t.Fatal(logoutErr)
		}
		if finishErr != nil {
			if !errors.Is(finishErr, identity.ErrInvalidProof) {
				t.Fatal(finishErr)
			}
			if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", ""); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatal("approval survived logout", err)
			}
		} else {
			retry, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", "")
			if err != nil || retry.Token != finish.Token {
				t.Fatal("consumed target tied to approver", err)
			}
		}
	}
}
