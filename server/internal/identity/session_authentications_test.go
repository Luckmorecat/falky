package identity_test

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestGuestAdmissionRecordsInitialAuthentication(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "events.db"))
	_, token := f.enter(t, "Guest")
	session, err := f.ident.ResolveSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	var method, purpose string
	var authenticatedAt int64
	var recent bool
	if err := f.db.Read().QueryRowContext(t.Context(), "SELECT method,purpose,authenticated_at,recent_proof FROM session_authentications WHERE session_id=?", session.ID).Scan(&method, &purpose, &authenticatedAt, &recent); err != nil {
		t.Fatal(err)
	}
	if method != "guest_link" || purpose != "sign_in" || authenticatedAt != f.clock.Now().Unix() || recent {
		t.Fatalf("guest event = %s %s %d %t", method, purpose, authenticatedAt, recent)
	}
}

func TestPasskeyIssuanceAndReauthenticationRecordOnlySuccessfulEvents(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "events.db"))
	account, key := enroll(t, f, "Account")
	assertEvent := func(sessionID string, want int, method, purpose string) {
		t.Helper()
		var count int
		var gotMethod, gotPurpose string
		var recent bool
		if err := f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM session_authentications WHERE session_id=?", sessionID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if err := f.db.Read().QueryRowContext(t.Context(), "SELECT method,purpose,recent_proof FROM session_authentications WHERE session_id=? ORDER BY id DESC LIMIT 1", sessionID).Scan(&gotMethod, &gotPurpose, &recent); err != nil {
			t.Fatal(err)
		}
		if count != want || gotMethod != method || gotPurpose != purpose || !recent {
			t.Fatalf("events = %d %s %s %t", count, gotMethod, gotPurpose, recent)
		}
	}
	assertEvent(account.Session.ID, 1, "passkey", "sign_in")
	login, err := f.ident.BeginAuthentication(t.Context(), "login")
	if err != nil {
		t.Fatal(err)
	}
	response := key.Assertion(t, login.Assertion, "https://falky.example")
	if _, err := f.ident.FinishAuthentication(t.Context(), login.ID, "wrong", response); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal(err)
	}
	other, err := f.ident.FinishAuthentication(t.Context(), login.ID, "login", response)
	if err != nil {
		t.Fatal(err)
	}
	assertEvent(other.Session.ID, 1, "passkey", "sign_in")
	reauth, err := f.ident.BeginReauthentication(t.Context(), account.Token, "reauth")
	if err != nil {
		t.Fatal(err)
	}
	response = key.Assertion(t, reauth.Assertion, "https://falky.example")
	if _, err := f.ident.FinishReauthentication(t.Context(), account.Token, reauth.ID, "wrong", response); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal(err)
	}
	assertEvent(account.Session.ID, 1, "passkey", "sign_in")
	if _, err := f.ident.FinishReauthentication(t.Context(), account.Token, reauth.ID, "reauth", response); err != nil {
		t.Fatal(err)
	}
	assertEvent(account.Session.ID, 2, "passkey", "reauthentication")
	// Both successes occurred in one second; insertion order determines the latest.
	if _, err := f.ident.FinishReauthentication(t.Context(), account.Token, reauth.ID, "reauth", response); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal(err)
	}
	assertEvent(account.Session.ID, 2, "passkey", "reauthentication")
	recovery, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, account.RecoveryCodes[0], "recovery")
	if err != nil {
		t.Fatal(err)
	}
	replacement := passkeytest.New(t)
	recovered, err := f.ident.FinishRecovery(t.Context(), recovery.ID, "recovery", replacement.Registration(t, recovery.Creation, "https://falky.example"), "Recovered")
	if err != nil {
		t.Fatal(err)
	}
	assertEvent(recovered.Session.ID, 1, "passkey", "sign_in")
	f.clock.Advance(identity.RecentProofTTL - time.Second)
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), recovered.Token); err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(time.Second)
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), recovered.Token); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatalf("five-minute boundary = %v", err)
	}
}

func TestAuthenticationSchemaRejectsInvalidEvidenceAndDuplicateInitialEvents(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "constraints.db"))
	account, key := enroll(t, f, "Account")
	for _, tt := range []struct {
		name, method, purpose       string
		credential, request, origin any
		recent                      int
	}{
		{"duplicate initial", "passkey", "sign_in", key.ID, nil, nil, 1},
		{"unknown method", "password", "reauthentication", nil, nil, nil, 1},
		{"unknown purpose", "passkey", "refresh", key.ID, nil, nil, 1},
		{"guest reauthentication", "guest_link", "reauthentication", nil, nil, nil, 0},
		{"guest proof", "guest_link", "sign_in", key.ID, nil, nil, 0},
		{"passkey origin", "passkey", "reauthentication", key.ID, nil, key.ID, 1},
		{"missing credential FK", "passkey", "reauthentication", []byte("missing"), nil, nil, 1},
		{"passkey flag", "passkey", "reauthentication", key.ID, nil, nil, 0},
		{"device reauthentication", "device_approval", "reauthentication", nil, nil, nil, 1},
		{"device passkey proof", "device_approval", "sign_in", key.ID, nil, nil, 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
				if tt.name != "duplicate initial" {
					if _, err := tx.ExecContext(t.Context(), "DELETE FROM session_authentications WHERE session_id=?", account.Session.ID); err != nil {
						return err
					}
				}
				_, err := tx.ExecContext(t.Context(), `INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,passkey_credential_id,device_approval_request_id,origin_passkey_credential_id,recent_proof) VALUES(?,?,?,?,?,?,?,?)`, account.Session.ID, tt.method, tt.purpose, f.clock.Now().Unix(), tt.credential, tt.request, tt.origin, tt.recent)
				return err
			})
			if err == nil {
				t.Fatal("accepted invalid authentication event")
			}
		})
	}
}

func TestApprovalSchemaConstraintsAndCycleSafeDeletion(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "approval-schema.db"))
	account, key := enroll(t, f, "Account")
	now := f.clock.Now().Unix()
	write := func(t *testing.T, statement string, args ...any) error {
		t.Helper()
		return f.db.Write(t.Context(), func(tx *sql.Tx) error { _, err := tx.ExecContext(t.Context(), statement, args...); return err })
	}
	if err := write(t, `INSERT INTO account_signin_links(id,identity_id,issuer_session_id,token_hash,state,created_at,expires_at) VALUES('link',?,?,?,'open',?,?)`, account.Session.Visitor.ID, account.Session.ID, make([]byte, 32), now, now+300); err != nil {
		t.Fatal(err)
	}
	base := `INSERT INTO account_signin_requests(id,type,state,browser_token_hash,link_id,code,qr_token_hash,created_at,expires_at,approved_at,created_session_id,consumed_at) VALUES('request',?,?,?,?,?,?,?,?,?,?,?)`
	for _, tt := range []struct {
		name, flow, state          string
		browser, link, code, qr    any
		expiry                     int64
		approved, result, consumed any
	}{
		{"unknown flow", "other", "pending", nil, nil, nil, nil, now + 300, nil, nil, nil},
		{"link without parent", "link", "pending", nil, nil, "0000", nil, now + 300, nil, nil, nil},
		{"qr with link", "qr", "pending", nil, "link", nil, nil, now + 300, nil, nil, nil},
		{"qr with code", "qr", "pending", nil, nil, "0000", nil, now + 300, nil, nil, nil},
		{"link with qr secret", "link", "pending", nil, "link", "0000", make([]byte, 32), now + 300, nil, nil, nil},
		{"short hash", "qr", "pending", []byte{1}, nil, nil, nil, now + 300, nil, nil, nil},
		{"bad code", "link", "pending", nil, "link", "12a4", nil, now + 300, nil, nil, nil},
		{"short code", "link", "pending", nil, "link", "123", nil, now + 300, nil, nil, nil},
		{"bad deadline", "qr", "pending", nil, nil, nil, nil, now + 301, nil, nil, nil},
		{"pending approval", "qr", "pending", nil, nil, nil, nil, now + 300, now, nil, nil},
		{"approved without time", "qr", "approved", nil, nil, nil, nil, now + 300, nil, nil, nil},
		{"consumed without result", "qr", "consumed", nil, nil, nil, nil, now + 300, now, nil, now},
		{"unknown state", "qr", "open", nil, nil, nil, nil, now + 300, nil, nil, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if err := write(t, base, tt.flow, tt.state, tt.browser, tt.link, tt.code, tt.qr, now, tt.expiry, tt.approved, tt.result, tt.consumed); err == nil {
				t.Fatal("accepted invalid request")
			}
		})
	}
	for _, stmt := range []string{
		`INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at) SELECT 'result',randomblob(32),identity_id,account_id,generation,created_at,expires_at FROM sessions WHERE id=?`,
		`INSERT INTO account_signin_requests(id,type,state,browser_token_hash,link_id,code,created_at,expires_at,approved_at,approved_by_session_id,origin_passkey_credential_id) VALUES('request','link','approved',randomblob(32),'link','0000',` + fmt.Sprint(now) + `,` + fmt.Sprint(now+300) + `,` + fmt.Sprint(now) + `,?,(SELECT credential_id FROM passkeys LIMIT 1))`,
	} {
		if err := write(t, stmt, account.Session.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := write(t, `INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,device_approval_request_id,origin_passkey_credential_id,recent_proof) VALUES('result','device_approval','sign_in',?,'request',?,1)`, now, key.ID); err != nil {
		t.Fatal(err)
	}
	if err := write(t, `UPDATE account_signin_requests SET state='consumed',created_session_id='result',consumed_at=?,delivery_ciphertext=x'01' WHERE id='request'`, now); err != nil {
		t.Fatal(err)
	}
	if err := write(t, `UPDATE account_signin_links SET state='consumed',consumed_at=? WHERE id='link'`, now); err != nil {
		t.Fatal(err)
	}
	// Successful metadata and events must permit secret erasure independently.
	if err := write(t, `UPDATE account_signin_requests SET browser_token_hash=NULL,code=NULL,delivery_ciphertext=NULL WHERE id='request'`); err != nil {
		t.Fatal(err)
	}
	if err := write(t, `DELETE FROM sessions WHERE id=?`, account.Session.ID); err != nil {
		t.Fatal(err)
	}
	var issuer, approver sql.NullString
	if err := f.db.Read().QueryRowContext(t.Context(), `SELECT l.issuer_session_id,r.approved_by_session_id FROM account_signin_links l JOIN account_signin_requests r ON r.link_id=l.id`).Scan(&issuer, &approver); err != nil {
		t.Fatal(err)
	}
	if issuer.Valid || approver.Valid {
		t.Fatal("historical issuer/approver FK did not clear")
	}
	if err := write(t, `DELETE FROM sessions WHERE id='result'`); err != nil {
		t.Fatal(err)
	}
	if err := write(t, `DELETE FROM account_signin_links WHERE id='link'`); err != nil {
		t.Fatal(err)
	}
	var requests, events, violations int
	for _, check := range []struct {
		query string
		dst   *int
	}{
		{`SELECT count(*) FROM account_signin_requests`, &requests},
		{`SELECT count(*) FROM session_authentications`, &events},
		{`SELECT count(*) FROM pragma_foreign_key_check`, &violations},
	} {
		if err := f.db.Read().QueryRowContext(t.Context(), check.query).Scan(check.dst); err != nil {
			t.Fatal(err)
		}
	}
	if requests != 0 || events != 0 || violations != 0 {
		t.Fatalf("requests=%d events=%d FK violations=%d", requests, events, violations)
	}
}

func TestPasskeyOriginRevocationSurvivesApproverLogoutAndCancelsUnredeemedApproval(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "origin.db"))
	account, origin := enroll(t, f, "Account")
	add, err := f.ident.BeginAddPasskey(t.Context(), account.Token, "add")
	if err != nil {
		t.Fatal(err)
	}
	replacement := passkeytest.New(t)
	if _, err := f.ident.FinishAddPasskey(t.Context(), account.Token, add.ID, "add", replacement.Registration(t, add.Creation, "https://falky.example"), "Replacement"); err != nil {
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
	now := f.clock.Now().Unix()
	if err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
		for _, target := range []string{"device-one", "device-chain"} {
			if _, err := tx.ExecContext(t.Context(), `INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at) SELECT ?,randomblob(32),identity_id,account_id,generation,created_at,expires_at FROM sessions WHERE id=?`, target, account.Session.ID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(t.Context(), `INSERT INTO account_signin_requests(id,type,state,browser_token_hash,qr_token_hash,created_at,expires_at,approved_at,approved_by_session_id,origin_passkey_credential_id) VALUES(?,'qr','approved',randomblob(32),randomblob(32),?,?,?,?,?)`, target, now, now+300, now, account.Session.ID, origin.ID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(t.Context(), `INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,device_approval_request_id,origin_passkey_credential_id,recent_proof) VALUES(?,'device_approval','sign_in',?,?,?,1)`, target, now, target, origin.ID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(t.Context(), `UPDATE account_signin_requests SET state='consumed',created_session_id=?,consumed_at=? WHERE id=?`, target, now, target); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(t.Context(), `INSERT INTO account_signin_requests(id,type,state,browser_token_hash,qr_token_hash,created_at,expires_at,approved_at,approved_by_session_id,origin_passkey_credential_id) VALUES('unfinished','qr','approved',randomblob(32),randomblob(32),?,?,?,?,?)`, now, now+300, now, remover.Session.ID, origin.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.Logout(t.Context(), account.Token); err != nil {
		t.Fatal(err)
	}
	effects, err := f.ident.RemovePasskeyWithEffects(t.Context(), remover.Token, base64.RawURLEncoding.EncodeToString(origin.ID))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, session := range effects.RevokedSessions {
		got[session.ID] = true
	}
	if len(got) != 2 || !got["device-one"] || !got["device-chain"] {
		t.Fatalf("origin revocations = %v", got)
	}
	var state string
	var credential []byte
	if err := f.db.Read().QueryRowContext(t.Context(), "SELECT state,origin_passkey_credential_id FROM account_signin_requests WHERE id='unfinished'").Scan(&state, &credential); err != nil {
		t.Fatal(err)
	}
	if state != "cancelled" || credential != nil {
		t.Fatalf("origin approval after removal = %s %x", state, credential)
	}
	if _, err := f.ident.ResolveSession(t.Context(), remover.Token); err != nil {
		t.Fatal(err)
	}
}
