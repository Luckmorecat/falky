//go:build integration

package voice_test

import (
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

// signIn signs login in again on ident and returns the new enrollment.
func signIn(t *testing.T, ident *identity.Service, login string) identity.Enrollment {
	t.Helper()
	pass, err := ident.PassAccess(t.Context(), "shared secret phrase")
	if err != nil {
		t.Fatal(err)
	}
	e, err := ident.Login(t.Context(), pass, login, testPassword)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// recoverAccount recovers login on ident with a fresh operator code.
func recoverAccount(t *testing.T, ident *identity.Service, login string) identity.Enrollment {
	t.Helper()
	code := operatorCode(t, ident, login)
	pass, err := ident.PassAccess(t.Context(), "shared secret phrase")
	if err != nil {
		t.Fatal(err)
	}
	e, err := ident.Recover(t.Context(), identity.RecoveryInput{AccessToken: pass, Account: login, Proof: code, Password: "a brand new password"})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// operatorCode has the operator issue a recovery code for login.
func operatorCode(t *testing.T, ident *identity.Service, login string) string {
	t.Helper()
	grant, err := ident.IssueRecovery(t.Context(), login)
	if err != nil {
		t.Fatal(err)
	}
	return grant.Token
}
