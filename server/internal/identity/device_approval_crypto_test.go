package identity_test

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestDeviceQRTokenMatchesIndependentHKDFVector(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	browser := strings.Repeat("B", 52)
	hash := sha256.Sum256([]byte(browser))
	// Independently calculated with RFC 5869's extract/expand HMAC steps.
	const expected = "P6ttggh-CnHK6fW9gm7e-ttbBodIBRTtPNUCadqaq6E"
	qrHash := sha256.Sum256([]byte(expected))
	now := f.clock.Now().Unix()
	if err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "INSERT INTO account_signin_requests(id,type,state,browser_token_hash,qr_token_hash,created_at,expires_at) VALUES('request-vector-1','qr','pending',?,?,?,?)", hash[:], qrHash[:], now, now+300)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	got, _, err := f.ident.BeginQRSignIn(t.Context(), browser, "", "", false, nil)
	if err != nil || got.QRToken != expected {
		t.Fatalf("HKDF vector=%q %v", got.QRToken, err)
	}
}

func TestDeviceEncryptedDeliveryRejectsStorageTamperingAndWrongContexts(t *testing.T) {
	for _, attack := range []string{"version", "truncated", "bit", "nonce", "request", "session", "deadline", "type", "plaintext"} {
		t.Run(attack, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			a, _ := enroll(t, f, "Alice")
			q, finish := deviceQR(t, f, a.Token)
			var ciphertext, browserHash, qrHash, tokenHash []byte
			if err := f.db.Read().QueryRowContext(t.Context(), "SELECT delivery_ciphertext,browser_token_hash,qr_token_hash FROM account_signin_requests WHERE id=?", q.Request.ID).Scan(&ciphertext, &browserHash, &qrHash); err != nil {
				t.Fatal(err)
			}
			if len(ciphertext) != 81 || ciphertext[0] != 1 || len(browserHash) != 32 || len(qrHash) != 32 || strings.Contains(string(ciphertext), finish.Token) {
				t.Fatal("unsafe delivery encoding")
			}
			if err := f.db.Read().QueryRowContext(t.Context(), "SELECT token_hash FROM sessions WHERE id=?", finish.Session.ID).Scan(&tokenHash); err != nil {
				t.Fatal(err)
			}
			expected := sha256.Sum256([]byte(finish.Token))
			if string(tokenHash) != string(expected[:]) {
				t.Fatal("session secret stored unhashed")
			}
			linkToken := ""
			var extraCiphertext []byte
			if attack == "request" {
				// Same browser secret, different request, valid ciphertext and resulting session.
				l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
				if err != nil {
					t.Fatal(err)
				}
				candidate, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, q.BrowserSecret, "", "")
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveSignInLink(t.Context(), a.Token, l.Link.ID, candidate.Code); err != nil {
					t.Fatal(err)
				}
				if _, err = f.ident.FinishSignInRequest(t.Context(), candidate.Request.ID, q.BrowserSecret, l.Token, ""); err != nil {
					t.Fatal(err)
				}
				if err = f.db.Read().QueryRowContext(t.Context(), "SELECT delivery_ciphertext FROM account_signin_requests WHERE id=?", candidate.Request.ID).Scan(&extraCiphertext); err != nil {
					t.Fatal(err)
				}
			}
			linkID := ""
			if attack == "type" {
				l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
				if err != nil {
					t.Fatal(err)
				}
				linkToken, linkID = l.Token, l.Link.ID
			}
			if err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
				var err error
				switch attack {
				case "version":
					ciphertext[0] = 2
				case "truncated":
					ciphertext = ciphertext[:12]
				case "bit":
					ciphertext[len(ciphertext)-1] ^= 1
				case "nonce":
					ciphertext[1] ^= 1
				case "request":
					ciphertext = extraCiphertext
				case "session":
					_, err = tx.ExecContext(t.Context(), "UPDATE account_signin_requests SET created_session_id=? WHERE id=?", a.Session.ID, q.Request.ID)
				case "deadline":
					_, err = tx.ExecContext(t.Context(), "UPDATE account_signin_requests SET created_at=created_at-1,expires_at=expires_at-1 WHERE id=?", q.Request.ID)
				case "type":
					_, err = tx.ExecContext(t.Context(), "UPDATE account_signin_requests SET type='link',link_id=?,qr_token_hash=NULL WHERE id=?", linkID, q.Request.ID)
				case "plaintext":
					_, err = tx.ExecContext(t.Context(), "UPDATE sessions SET token_hash=randomblob(32) WHERE id=?", finish.Session.ID)
				}
				if err != nil {
					return err
				}
				_, err = tx.ExecContext(t.Context(), "UPDATE account_signin_requests SET delivery_ciphertext=? WHERE id=?", ciphertext, q.Request.ID)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, linkToken, ""); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatalf("accepted %s tampering: %v", attack, err)
			}
		})
	}
}

func TestDeviceWrongFlowAndSelectorCannotAuthorizeBrowser(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, _ := enroll(t, f, "Alice")
	l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
	if err != nil {
		t.Fatal(err)
	}
	q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range []string{"", q.QRToken, q.Request.ID, l.Token} {
		if _, err = f.ident.SignInRequest(t.Context(), q.Request.ID, binding); !errors.Is(err, identity.ErrInvalidProof) {
			t.Fatal("selector read browser state", err)
		}
	}
	if _, err = f.ident.ResendSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, l.Token); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("QR resend", err)
	}
	if _, err = f.ident.DenySignInRequest(t.Context(), a.Token, l.Link.ID, q.Request.ID); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("QR link denial", err)
	}
	if _, _, err = f.ident.BeginSignInRequest(t.Context(), q.QRToken, "", "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("QR link begin", err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, l.Token); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("link QR approve", err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, q.QRToken); err != nil {
		t.Fatal(err)
	}
	if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, l.Token, ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("QR accepted link token", err)
	}
	if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, strings.Repeat("X", 52), "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("cross-browser replay", err)
	}
}
