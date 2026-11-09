package identity_test

import (
	"encoding/base64"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestInvitationEnrollsRealPasskeyAndPreservesGuestIdentity(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	guest, token := f.enter(t, "Alice")
	invite, err := f.ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ceremony, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: invite.Token, GuestToken: token, Name: "Alice", BrowserContext: "browser-secret"})
	if err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	result, err := f.ident.FinishRegistration(t.Context(), ceremony.ID, "browser-secret", key.Registration(t, ceremony.Creation, "https://falky.example"), "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	if result.Session.Visitor.ID != guest.ID || result.Session.Kind != identity.Account || len(result.RecoveryCodes) != 10 {
		t.Fatalf("registration identity=%s kind=%s codes=%d", result.Session.Visitor.ID, result.Session.Kind, len(result.RecoveryCodes))
	}
	if _, err := f.ident.Resolve(t.Context(), token); err == nil {
		t.Fatal("old guest cookie survived upgrade")
	}
	if _, err := f.ident.Rotate(t.Context()); err != nil {
		t.Fatal(err)
	}
	got, err := f.ident.Resolve(t.Context(), result.Token)
	if err != nil || got.ID != guest.ID || got.Colour != guest.Colour {
		t.Fatalf("account after guest rotation = %+v, %v", got, err)
	}
}

func enroll(t *testing.T, f fixture, name string) (identity.Enrollment, *passkeytest.Authenticator) {
	t.Helper()
	i, err := f.ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: name, BrowserContext: "browser-secret"})
	if err != nil {
		t.Fatal(err)
	}
	k := passkeytest.New(t)
	r, err := f.ident.FinishRegistration(t.Context(), c.ID, "browser-secret", k.Registration(t, c.Creation, "https://falky.example"), "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	return r, k
}

func TestRegisteredNameRemainsReservedWhenGuestHoldsExpire(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	enroll(t, f, "Alice")
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "ALICE"); !errors.Is(err, identity.ErrNameTaken) {
		t.Fatalf("guest claimed registered name: %v", err)
	}
}

func TestDiscoverableLoginBindsBrowserAndRejectsReplay(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, key := enroll(t, f, "Alice")
	c, err := f.ident.BeginAuthentication(t.Context(), "login-browser")
	if err != nil {
		t.Fatal(err)
	}
	response := key.Assertion(t, c.Assertion, "https://falky.example")
	if _, err := f.ident.FinishAuthentication(t.Context(), c.ID, "other-browser", response); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("cross-browser assertion = %v", err)
	}
	loggedIn, err := f.ident.FinishAuthentication(t.Context(), c.ID, "login-browser", response)
	if err != nil {
		t.Fatal(err)
	}
	if loggedIn.Session.Visitor.ID != account.Session.Visitor.ID || loggedIn.Session.ID == account.Session.ID {
		t.Fatal("login did not issue a distinct session for the account")
	}
	if _, err := f.ident.FinishAuthentication(t.Context(), c.ID, "login-browser", response); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("replayed assertion = %v", err)
	}
}

func TestRecoveryCommitsReplacementAndRevokesAllOldAccessOnce(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, oldKey := enroll(t, f, "Alice")
	grant, err := f.ident.IssueRecovery(t.Context(), account.Session.Visitor.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.ResolveSession(t.Context(), account.Token); err != nil {
		t.Fatal("issuing recovery revoked session")
	}
	c, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, account.RecoveryCodes[0], "recovery-browser")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.FinishRecovery(t.Context(), c.ID, "recovery-browser", []byte(`{}`), "Replacement"); err == nil {
		t.Fatal("invalid enrollment succeeded")
	}
	key := passkeytest.New(t)
	response := key.Registration(t, c.Creation, "https://falky.example")
	concurrent, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, account.RecoveryCodes[0], "recovery-browser")
	if err != nil {
		t.Fatal(err)
	}
	concurrentResponse := key.Registration(t, concurrent.Creation, "https://falky.example")
	var wg sync.WaitGroup
	results := make(chan identity.Enrollment, 2)
	failures := make(chan error, 2)
	for _, attempt := range []struct {
		id       string
		response []byte
	}{{c.ID, response}, {concurrent.ID, concurrentResponse}} {
		wg.Go(func() {
			r, err := f.ident.FinishRecovery(t.Context(), attempt.id, "recovery-browser", attempt.response, "Replacement")
			if err != nil {
				failures <- err
			} else {
				results <- r
			}
		})
	}
	wg.Wait()
	close(results)
	close(failures)
	if len(results) != 1 || len(failures) != 1 {
		t.Fatalf("recovery winners=%d failures=%d", len(results), len(failures))
	}
	got := <-results
	if got.Session.Visitor.ID != account.Session.Visitor.ID || got.Session.Generation <= account.Session.Generation || len(got.Effects.RevokedSessions) != 1 || len(got.RecoveryCodes) != 10 {
		t.Fatal("recovery lost identity, generation, revoked sessions, or fresh codes")
	}
	if _, err := f.ident.ResolveSession(t.Context(), account.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("old session = %v", err)
	}
	if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, grant.Token, "recovery-browser"); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("old grant = %v", err)
	}
	if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, account.RecoveryCodes[1], "recovery-browser"); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("old code = %v", err)
	}
	login, err := f.ident.BeginAuthentication(t.Context(), "login")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.FinishAuthentication(t.Context(), login.ID, "login", oldKey.Assertion(t, login.Assertion, "https://falky.example")); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("old key = %v", err)
	}
	if _, err := f.ident.FinishAuthentication(t.Context(), login.ID, "login", key.Assertion(t, login.Assertion, "https://falky.example")); err != nil {
		t.Fatal(err)
	}
}

func TestSensitiveChangesRequireSessionSpecificRecentPasskeyProof(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, key := enroll(t, f, "Alice")
	login, err := f.ident.BeginAuthentication(t.Context(), "other-device")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.ident.FinishAuthentication(t.Context(), login.ID, "other-device", key.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(identity.RecentProofTTL)
	if _, err := f.ident.BeginAddPasskey(t.Context(), account.Token, "browser"); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatalf("add without proof = %v", err)
	}
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), account.Token); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatalf("codes without proof = %v", err)
	}
	if err := f.ident.RemovePasskey(t.Context(), account.Token, base64.RawURLEncoding.EncodeToString(key.ID)); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatalf("remove without proof = %v", err)
	}
	c, err := f.ident.BeginReauthentication(t.Context(), account.Token, "browser")
	if err != nil {
		t.Fatal(err)
	}
	response := key.Assertion(t, c.Assertion, "https://falky.example")
	if _, err := f.ident.FinishReauthentication(t.Context(), other.Token, c.ID, "browser", response); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("proof reused by another session = %v", err)
	}
	if _, err := f.ident.FinishAuthentication(t.Context(), c.ID, "browser", response); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("reauthentication used for login = %v", err)
	}
	if _, err := f.ident.FinishReauthentication(t.Context(), account.Token, c.ID, "browser", response); err != nil {
		t.Fatal(err)
	}
	refreshed, err := f.ident.ResolveSession(t.Context(), account.Token)
	if err != nil || !refreshed.ExpiresAt.Equal(account.Session.ExpiresAt) {
		t.Fatalf("recent proof extended session expiry: %+v, %v", refreshed, err)
	}
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), account.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), other.Token); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatalf("other session inherited proof = %v", err)
	}
}

func TestConcurrentPasskeyRemovalCannotRemoveTheLastCredential(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, first := enroll(t, f, "Alice")
	add, err := f.ident.BeginAddPasskey(t.Context(), account.Token, "browser")
	if err != nil {
		t.Fatal(err)
	}
	second := passkeytest.New(t)
	if _, err := f.ident.FinishAddPasskey(t.Context(), account.Token, add.ID, "browser", second.Registration(t, add.Creation, "https://falky.example"), "Phone"); err != nil {
		t.Fatal(err)
	}
	keys, err := f.ident.Passkeys(t.Context(), account.Token)
	if err != nil || len(keys) != 2 {
		t.Fatalf("keys count=%d error=%v", len(keys), err)
	}
	login, err := f.ident.BeginAuthentication(t.Context(), "phone")
	if err != nil {
		t.Fatal(err)
	}
	phone, err := f.ident.FinishAuthentication(t.Context(), login.ID, "phone", second.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Go(func() {
		results <- f.ident.RemovePasskey(t.Context(), account.Token, base64.RawURLEncoding.EncodeToString(first.ID))
	})
	wg.Go(func() {
		results <- f.ident.RemovePasskey(t.Context(), phone.Token, base64.RawURLEncoding.EncodeToString(second.ID))
	})
	wg.Wait()
	close(results)
	var successes, refusals int
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, identity.ErrLastPasskey):
			refusals++
		default:
			t.Fatal(err)
		}
	}
	if successes != 1 || refusals != 1 {
		t.Fatalf("removal successes=%d last-key refusals=%d", successes, refusals)
	}
	keys, err = f.ident.Passkeys(t.Context(), account.Token)
	if err != nil || len(keys) != 1 {
		t.Fatalf("remaining count=%d error=%v", len(keys), err)
	}
}

func TestOnlyCredentialOwnerCanManagePasskeysAndCredentialIDsCannotBeShared(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	first, key := enroll(t, f, "Alice")
	second, _ := enroll(t, f, "Bob")
	if err := f.ident.RemovePasskey(t.Context(), second.Token, base64.RawURLEncoding.EncodeToString(key.ID)); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("foreign key removal = %v", err)
	}
	c, err := f.ident.BeginAddPasskey(t.Context(), first.Token, "browser")
	if err != nil {
		t.Fatal(err)
	}
	newKey := passkeytest.New(t)
	response := newKey.Registration(t, c.Creation, "https://falky.example")
	if _, err := f.ident.FinishAddPasskey(t.Context(), second.Token, c.ID, "browser", response, "Other account"); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("foreign enrollment = %v", err)
	}
	duplicate, err := f.ident.BeginAddPasskey(t.Context(), second.Token, "browser")
	if err != nil {
		t.Fatal(err)
	}
	duplicateKey := passkeytest.New(t)
	duplicateKey.ID = append([]byte{}, key.ID...)
	if _, err := f.ident.FinishAddPasskey(t.Context(), second.Token, duplicate.ID, "browser", duplicateKey.Registration(t, duplicate.Creation, "https://falky.example"), "Duplicate"); !errors.Is(err, identity.ErrCredentialExists) {
		t.Fatalf("shared credential ID = %v", err)
	}
}

func TestAccountSessionHasNinetyDayAbsoluteExpiryAndLogoutIsSelective(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, key := enroll(t, f, "Alice")
	if account.Session.ExpiresAt.Sub(f.clock.Now()) != 90*24*time.Hour {
		t.Fatal("wrong absolute session lifetime")
	}
	login, err := f.ident.BeginAuthentication(t.Context(), "other")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.ident.FinishAuthentication(t.Context(), login.ID, "other", key.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	effects, err := f.ident.Logout(t.Context(), account.Token)
	if err != nil {
		t.Fatal(err)
	}
	if len(effects.RevokedSessions) != 1 || effects.RevokedSessions[0].ID != account.Session.ID {
		t.Fatal("logout effects do not select the session")
	}
	if _, err := f.ident.ValidateSession(t.Context(), account.Session); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("logged out snapshot = %v", err)
	}
	f.clock.Advance(identity.AccountSessionTTL - time.Second)
	if _, err := f.ident.ResolveSession(t.Context(), other.Token); err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(time.Second)
	if _, err := f.ident.ResolveSession(t.Context(), other.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("expired account session = %v", err)
	}
}

func TestRemovedProvingPasskeyInvalidatesFreshnessWithoutEndingSession(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "proof.db"))
	account, first := enroll(t, f, "Account")
	add, err := f.ident.BeginAddPasskey(t.Context(), account.Token, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	replacement := passkeytest.New(t)
	if _, err := f.ident.FinishAddPasskey(t.Context(), account.Token, add.ID, "laptop", replacement.Registration(t, add.Creation, "https://falky.example"), "Replacement"); err != nil {
		t.Fatal(err)
	}
	login, err := f.ident.BeginAuthentication(t.Context(), "other")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.ident.FinishAuthentication(t.Context(), login.ID, "other", first.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	reauth, err := f.ident.BeginReauthentication(t.Context(), account.Token, "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.FinishReauthentication(t.Context(), account.Token, reauth.ID, "laptop", replacement.Assertion(t, reauth.Assertion, "https://falky.example")); err != nil {
		t.Fatal(err)
	}
	if err := f.ident.RemovePasskey(t.Context(), account.Token, base64.RawURLEncoding.EncodeToString(first.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), other.Token); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatalf("removed credential still justified sensitive action: %v", err)
	}
	resolved, err := f.ident.ResolveSession(t.Context(), other.Token)
	if err != nil || resolved != other.Session {
		t.Fatalf("credential removal ended ordinary session access: %+v, %v", resolved, err)
	}
	if _, err := f.ident.RegenerateRecoveryCodes(t.Context(), account.Token); err != nil {
		t.Fatalf("remaining credential lost its recent proof: %v", err)
	}
}
