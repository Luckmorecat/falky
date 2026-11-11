package identity_test

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"path/filepath"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func assertDeviceCredentialChangesBlocked(t *testing.T, f fixture, token, credential string) {
	t.Helper()
	if _, err := f.ident.BeginAddPasskey(t.Context(), token, "add"); !errors.Is(err, identity.ErrRecentProof) {
		t.Errorf("begin passkey enrollment = %v, want recent proof", err)
	}
	if _, err := f.ident.FinishAddPasskey(t.Context(), token, "untrusted-ceremony", "add", nil, "Attacker"); !errors.Is(err, identity.ErrRecentProof) {
		t.Errorf("finish passkey enrollment = %v, want recent proof", err)
	}
	if _, err := f.ident.RemovePasskeyWithEffects(t.Context(), token, credential); !errors.Is(err, identity.ErrRecentProof) {
		t.Errorf("remove passkey = %v, want recent proof", err)
	}
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), token); !errors.Is(err, identity.ErrRecentProof) {
		t.Errorf("rotate recovery phrase = %v, want recent proof", err)
	}
}

func TestDeviceCredentialChangesRequireReceivingSessionPasskey(t *testing.T) {
	for _, flow := range []string{"qr", "link"} {
		t.Run(flow, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			victim, key := enroll(t, f, "Alice")
			var receiving identity.SignInFinish
			if flow == "qr" {
				_, receiving = deviceQR(t, f, victim.Token)
			} else {
				link, _, err := f.ident.CreateSignInLink(t.Context(), victim.Token)
				if err != nil {
					t.Fatal(err)
				}
				candidate, _, err := f.ident.BeginSignInRequest(t.Context(), link.Token, "", "", "Attacker")
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveSignInLink(t.Context(), victim.Token, link.Link.ID, candidate.Code); err != nil {
					t.Fatal(err)
				}
				receiving, err = f.ident.FinishSignInRequest(t.Context(), candidate.Request.ID, candidate.BrowserSecret, link.Token, "")
				if err != nil {
					t.Fatal(err)
				}
			}
			credential := base64.RawURLEncoding.EncodeToString(key.ID)
			assertDeviceCredentialChangesBlocked(t, f, receiving.Token, credential)
			if _, err := f.ident.ResolveSession(t.Context(), receiving.Token); err != nil {
				t.Fatal("ordinary access", err)
			}

			reauth, err := f.ident.BeginReauthentication(t.Context(), receiving.Token, "reauth")
			if err != nil {
				t.Fatal(err)
			}
			response := key.Assertion(t, reauth.Assertion, "https://falky.example")
			if _, err = f.ident.FinishReauthentication(t.Context(), receiving.Token, reauth.ID, "wrong-browser", response); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatal(err)
			}
			assertDeviceCredentialChangesBlocked(t, f, receiving.Token, credential)
			verified, err := f.ident.FinishReauthentication(t.Context(), receiving.Token, reauth.ID, "reauth", response)
			if err != nil {
				t.Fatal(err)
			}
			if verified.ID != receiving.Session.ID || !verified.ExpiresAt.Equal(receiving.Session.ExpiresAt) {
				t.Fatal("reauthentication changed session access")
			}
			add, err := f.ident.BeginAddPasskey(t.Context(), receiving.Token, "add")
			if err != nil {
				t.Fatal(err)
			}
			additional := passkeytest.New(t)
			added, err := f.ident.FinishAddPasskey(t.Context(), receiving.Token, add.ID, "add", additional.Registration(t, add.Creation, "https://falky.example"), "Additional")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.ident.RemovePasskeyWithEffects(t.Context(), receiving.Token, added.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = f.ident.RegenerateRecoveryCodes(t.Context(), receiving.Token); err != nil {
				t.Fatal(err)
			}
			pendingAdd, err := f.ident.BeginAddPasskey(t.Context(), receiving.Token, "pending-add")
			if err != nil {
				t.Fatal(err)
			}
			pendingResponse := additional.Registration(t, pendingAdd.Creation, "https://falky.example")
			f.clock.Advance(identity.RecentProofTTL)
			assertDeviceCredentialChangesBlocked(t, f, receiving.Token, credential)
			if _, err = f.ident.FinishAddPasskey(t.Context(), receiving.Token, pendingAdd.ID, "pending-add", pendingResponse, "Expired"); !errors.Is(err, identity.ErrRecentProof) {
				t.Fatal("enrollment outlived receiving-session proof", err)
			}
		})
	}
}

func TestDeviceApprovalCompatibilityAndLegacyFlagsGrantNoProof(t *testing.T) {
	for _, flow := range []string{"qr", "link"} {
		t.Run(flow, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			account, key := enroll(t, f, "Alice")
			var candidate identity.SignInBeginResult
			var linkToken string
			if flow == "qr" {
				var err error
				candidate, _, err = f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
				if err != nil {
					t.Fatal(err)
				}
				preview, err := f.ident.PreviewQRSignIn(t.Context(), account.Token, candidate.QRToken)
				if err != nil {
					t.Fatal(err)
				}
				if preview.ApprovalGrantsRecentProof {
					t.Error("QR preview promises inherited passkey proof")
				}
				if _, _, err = f.ident.ApproveQRSignIn(t.Context(), account.Token, candidate.QRToken); err != nil {
					t.Fatal(err)
				}
			} else {
				link, _, err := f.ident.CreateSignInLink(t.Context(), account.Token)
				if err != nil {
					t.Fatal(err)
				}
				if link.Link.ApprovalGrantsRecentProof {
					t.Error("new link promises inherited passkey proof")
				}
				view, err := f.ident.SignInLink(t.Context(), account.Token, link.Link.ID)
				if err != nil {
					t.Fatal(err)
				}
				if view.ApprovalGrantsRecentProof {
					t.Error("link view promises inherited passkey proof")
				}
				links, err := f.ident.SignInLinks(t.Context(), account.Token)
				if err != nil {
					t.Fatal(err)
				}
				if len(links) != 1 || links[0].ApprovalGrantsRecentProof {
					t.Fatalf("link list = %+v", links)
				}
				linkToken = link.Token
				candidate, _, err = f.ident.BeginSignInRequest(t.Context(), link.Token, "", "", "")
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveSignInLink(t.Context(), account.Token, link.Link.ID, candidate.Code); err != nil {
					t.Fatal(err)
				}
			}
			var recent bool
			if err := f.db.Read().QueryRowContext(t.Context(), "SELECT approver_recent_proof FROM account_signin_requests WHERE id=?", candidate.Request.ID).Scan(&recent); err != nil {
				t.Fatal(err)
			}
			if recent {
				t.Error("new approval stores inherited passkey proof")
			}
			// Simulate an approved request retained from before the security tightening.
			if err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
				_, err := tx.ExecContext(t.Context(), "UPDATE account_signin_requests SET approver_recent_proof=1 WHERE id=?", candidate.Request.ID)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			receiving, err := f.ident.FinishSignInRequest(t.Context(), candidate.Request.ID, candidate.BrowserSecret, linkToken, "")
			if err != nil {
				t.Fatal(err)
			}
			if err = f.db.Read().QueryRowContext(t.Context(), "SELECT recent_proof FROM session_authentications WHERE session_id=?", receiving.Session.ID).Scan(&recent); err != nil {
				t.Fatal(err)
			}
			if recent {
				t.Error("legacy request transferred passkey proof to a new session")
			}
			credential := base64.RawURLEncoding.EncodeToString(key.ID)
			assertDeviceCredentialChangesBlocked(t, f, receiving.Token, credential)
			// Existing sessions may also retain true historical flags without a rewrite.
			if err = f.db.Write(t.Context(), func(tx *sql.Tx) error {
				_, err := tx.ExecContext(t.Context(), "UPDATE session_authentications SET recent_proof=1 WHERE session_id=?", receiving.Session.ID)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			assertDeviceCredentialChangesBlocked(t, f, receiving.Token, credential)
			reauth, err := f.ident.BeginReauthentication(t.Context(), receiving.Token, "reauth")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.ident.FinishReauthentication(t.Context(), receiving.Token, reauth.ID, "reauth", key.Assertion(t, reauth.Assertion, "https://falky.example")); err != nil {
				t.Fatal(err)
			}
			if _, err = f.ident.RegenerateRecoveryCodes(t.Context(), receiving.Token); err != nil {
				t.Fatal("legacy device event prevented legitimate proof", err)
			}
		})
	}
}
