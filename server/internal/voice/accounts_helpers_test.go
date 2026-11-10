package voice_test

import (
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
)

// testPassword is the password every test account registers with.
const testPassword = "correct horse battery"

var accountCount atomic.Uint32

// registerAccount registers an account on ident, giving the access password
// first and setting it when the server has none, and returns its enrollment
// and login.
func registerAccount(t *testing.T, ident *identity.Service) (identity.Enrollment, string) {
	t.Helper()
	const access = "shared secret phrase"
	set, err := ident.AccessPasswordSet(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !set {
		if err := ident.SetAccessPassword(t.Context(), access); err != nil {
			t.Fatal(err)
		}
	}
	pass, err := ident.PassAccess(t.Context(), access)
	if err != nil {
		t.Fatal(err)
	}
	n := accountCount.Add(1)
	login := fmt.Sprintf("account-%d", n)
	e, err := ident.Register(t.Context(), identity.RegistrationInput{AccessToken: pass, Login: login, Password: testPassword, Name: fmt.Sprintf("Account %d", n)})
	if err != nil {
		t.Fatal(err)
	}
	return e, login
}
