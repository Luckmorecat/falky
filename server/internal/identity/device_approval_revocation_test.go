package identity_test

import (
	"encoding/base64"
	"errors"
	"path/filepath"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestDeviceOriginChainsAndUnredeemedApprovalRevokedAfterOriginalLogout(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, origin := enroll(t, f, "Alice")
	add, err := f.ident.BeginAddPasskey(t.Context(), a.Token, "add")
	if err != nil {
		t.Fatal(err)
	}
	replacement := passkeytest.New(t)
	if _, err = f.ident.FinishAddPasskey(t.Context(), a.Token, add.ID, "add", replacement.Registration(t, add.Creation, "https://falky.example"), "Replacement"); err != nil {
		t.Fatal(err)
	}
	login, err := f.ident.BeginAuthentication(t.Context(), "replacement")
	if err != nil {
		t.Fatal(err)
	}
	remover, err := f.ident.FinishAuthentication(t.Context(), login.ID, "replacement", replacement.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	_, first := deviceQR(t, f, a.Token)
	_, chain := deviceQR(t, f, first.Token)
	reauth, err := f.ident.BeginReauthentication(t.Context(), chain.Token, "reauth")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.ident.FinishReauthentication(t.Context(), chain.Token, reauth.ID, "reauth", replacement.Assertion(t, reauth.Assertion, "https://falky.example")); err != nil {
		t.Fatal(err)
	}
	if _, err = f.ident.RegenerateRecoveryCodes(t.Context(), chain.Token); err != nil {
		t.Fatal("receiving-session proof did not authorize credential changes", err)
	}
	if _, err = f.ident.Logout(t.Context(), a.Token); err != nil {
		t.Fatal(err)
	}
	q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), chain.Token, q.QRToken); err != nil {
		t.Fatal(err)
	}
	effects, err := f.ident.RemovePasskeyWithEffects(t.Context(), remover.Token, base64.RawURLEncoding.EncodeToString(origin.ID))
	if err != nil {
		t.Fatal(err)
	}
	revoked := map[string]bool{}
	for _, session := range effects.RevokedSessions {
		revoked[session.ID] = true
	}
	if len(revoked) != 2 || !revoked[first.Session.ID] || !revoked[chain.Session.ID] {
		t.Fatalf("origin chain=%+v", revoked)
	}
	if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("origin approval survived", err)
	}
	var originAfter []byte
	var state string
	if err = f.db.Read().QueryRowContext(t.Context(), "SELECT state,origin_passkey_credential_id FROM account_signin_requests WHERE id=?", q.Request.ID).Scan(&state, &originAfter); err != nil || state != "cancelled" || originAfter != nil {
		t.Fatalf("origin cancellation=%s %x %v", state, originAfter, err)
	}
	if _, err = f.ident.ResolveSession(t.Context(), remover.Token); err != nil {
		t.Fatal("other origin revoked", err)
	}
}

func TestDeviceDisableAndRecoveryCancelPendingLinkAndApprovedQRButNotAnonymousQR(t *testing.T) {
	for _, operation := range []string{"disable", "recovery"} {
		t.Run(operation, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			a, _ := enroll(t, f, "Alice")
			l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
			if err != nil {
				t.Fatal(err)
			}
			link, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", "")
			if err != nil {
				t.Fatal(err)
			}
			qr, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, qr.QRToken); err != nil {
				t.Fatal(err)
			}
			anonymous, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
			if err != nil {
				t.Fatal(err)
			}
			var effects identity.Effects
			if operation == "disable" {
				effects, err = f.ident.DisableAccount(t.Context(), a.Session.Visitor.ID)
			} else {
				c, beginErr := f.ident.BeginRecovery(t.Context(), a.Session.Visitor.ID, a.RecoveryCodes[0], "recover")
				if beginErr != nil {
					t.Fatal(beginErr)
				}
				key := passkeytest.New(t)
				recovery, finishErr := f.ident.FinishRecovery(t.Context(), c.ID, "recover", key.Registration(t, c.Creation, "https://falky.example"), "New")
				err = finishErr
				effects = recovery.Effects
			}
			if err != nil {
				t.Fatal(err)
			}
			changed := map[string]string{}
			for _, c := range effects.SignInChanges {
				changed[c.Request.ID] = c.Request.State
			}
			if changed[link.Request.ID] != "cancelled" || changed[qr.Request.ID] != "cancelled" || len(changed) != 2 {
				t.Fatalf("effects=%+v", effects)
			}
			if state, err := f.ident.SignInRequest(t.Context(), anonymous.Request.ID, anonymous.BrowserSecret); err != nil || state.State != "pending" {
				t.Fatalf("unclaimed QR invalidated=%+v %v", state, err)
			}
			for _, r := range []struct {
				q     identity.SignInBeginResult
				token string
			}{{link, l.Token}, {qr, ""}} {
				if _, err = f.ident.FinishSignInRequest(t.Context(), r.q.Request.ID, r.q.BrowserSecret, r.token, ""); !errors.Is(err, identity.ErrInvalidProof) {
					t.Fatal(err)
				}
			}
		})
	}
}
