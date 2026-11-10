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

func TestRecoveryWithAnOperatorCodeSetsANewPasswordAndEndsOldSessions(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	ctx := t.Context()
	account := register(t, f.ident, f.pass, "Alice")
	register(t, f.ident, f.pass, "Other")
	stale, err := f.ident.Login(ctx, f.pass, "alice", password)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.ident.IssueRecovery(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	recover := func(account, code string) error {
		_, err := f.ident.Recover(ctx, identity.RecoveryInput{AccessToken: f.pass, Account: account, Proof: code, Password: "a brand new password"})
		return err
	}
	for _, other := range []string{"other", "nobody"} {
		if err := recover(other, grant.Token); !errors.Is(err, identity.ErrInvalidProof) {
			t.Fatalf("Recover %s with Alice's code: %v, want ErrInvalidProof", other, err)
		}
	}
	if _, err := f.ident.Recover(ctx, identity.RecoveryInput{Account: "alice", Proof: grant.Token, Password: "a brand new password"}); !errors.Is(err, identity.ErrAccessRequired) {
		t.Fatalf("Recover without a pass: %v, want ErrAccessRequired", err)
	}
	result, err := f.ident.Recover(ctx, identity.RecoveryInput{AccessToken: f.pass, Account: "ALICE", Proof: grant.Token, Password: "a brand new password"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Session.Visitor.ID != account.Session.Visitor.ID || len(result.Effects.RevokedSessions) != 2 {
		t.Fatalf("recovery = %+v, want Alice with both old sessions revoked", result)
	}
	for _, token := range []string{account.Token, stale.Token} {
		if _, err := f.ident.Resolve(ctx, token); !errors.Is(err, identity.ErrNoVisitor) {
			t.Fatalf("an old session survived recovery: %v", err)
		}
	}
	if err := recover("alice", grant.Token); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("a used code recovered again: %v", err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "alice", "a brand new password"); err != nil {
		t.Fatalf("the new password does not sign in: %v", err)
	}
	var stored int
	if err := f.db.Read().QueryRowContext(ctx, "SELECT count(*) FROM account_recovery_proofs WHERE token_hash=?", hashOf(grant.Token)).Scan(&stored); err != nil || stored != 0 {
		t.Fatalf("used codes stored = %d, %v; want none", stored, err)
	}
}

func hashOf(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

func TestOperatorRecoveryCodeIsExactAndExpires(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	ctx := t.Context()
	account := register(t, f.ident, f.pass, "Alice")
	grant, err := f.ident.IssueRecovery(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if grant.AccountID != account.Session.Visitor.ID || !strings.HasPrefix(grant.Link, "https://falky.example/#recover=") || !strings.HasSuffix(grant.Link, "&account=alice") {
		t.Fatalf("grant = %+v", grant)
	}
	recover := func(proof string) error {
		_, err := f.ident.Recover(ctx, identity.RecoveryInput{AccessToken: f.pass, Account: "alice", Proof: proof, Password: "a brand new password"})
		return err
	}
	for _, proof := range []string{strings.ToLower(grant.Token), " " + grant.Token} {
		if err := recover(proof); !errors.Is(err, identity.ErrInvalidProof) {
			t.Fatalf("Recover with altered operator code: %v, want ErrInvalidProof", err)
		}
	}
	f.clock.Advance(identity.OperatorRecoveryTTL)
	if err := recover(grant.Token); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("an expired operator code recovered: %v", err)
	}
	fresh, err := f.ident.IssueRecovery(ctx, account.Session.Visitor.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := recover(fresh.Token); err != nil {
		t.Fatalf("Recover with a fresh operator code: %v", err)
	}
	if _, err := f.ident.IssueRecovery(ctx, "nobody"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("IssueRecovery(nobody): %v, want ErrNoVisitor", err)
	}
}

func TestAnAccountFromBeforePasswordsChoosesALoginWhenRecovering(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	ctx := t.Context()
	old := register(t, f.ident, f.pass, "Alice")
	register(t, f.ident, f.pass, "Taken")
	id := old.Session.Visitor.ID
	if err := f.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE accounts SET login_key=NULL, password_hash=NULL WHERE identity_id=?", id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "alice", password); !errors.Is(err, identity.ErrWrongCredentials) {
		t.Fatalf("an account without a password signed in: %v", err)
	}
	grant, err := f.ident.IssueRecovery(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(grant.Link, "&account="+id) {
		t.Fatalf("link %q, want it to name the account by ID", grant.Link)
	}
	attempt := func(login string) error {
		_, err := f.ident.Recover(ctx, identity.RecoveryInput{AccessToken: f.pass, Account: id, Proof: grant.Token, Password: "a brand new password", Login: login})
		return err
	}
	for login, want := range map[string]error{"": identity.ErrLoginRequired, "x": identity.ErrInvalidLogin, "taken": identity.ErrLoginTaken} {
		if err := attempt(login); !errors.Is(err, want) {
			t.Fatalf("Recover with login %q: %v, want %v", login, err, want)
		}
	}
	if err := attempt("Alice.New"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "alice.new", "a brand new password"); err != nil {
		t.Fatalf("the chosen login does not sign in: %v", err)
	}
}

func TestDisabledAccountsCannotRecover(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	ctx := t.Context()
	register(t, f.ident, f.pass, "Alice")
	grant, err := f.ident.IssueRecovery(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.DisableAccount(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.IssueRecovery(ctx, "alice"); !errors.Is(err, identity.ErrDisabled) {
		t.Fatalf("IssueRecovery(disabled): %v, want ErrDisabled", err)
	}
	_, err = f.ident.Recover(ctx, identity.RecoveryInput{AccessToken: f.pass, Account: "alice", Proof: grant.Token, Password: "a brand new password"})
	if !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("Recover(disabled): %v, want ErrInvalidProof", err)
	}
}

func TestAnAccountIDNamesItsAccountEvenWhenItIsAlsoSomeonesLogin(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	ctx := t.Context()
	alice := register(t, f.ident, f.pass, "Alice").Session.Visitor.ID
	squatter, err := f.ident.Register(ctx, identity.RegistrationInput{AccessToken: f.pass, Login: strings.ToLower(alice), Password: password, Name: "Squatter"})
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.ident.IssueRecovery(ctx, alice)
	if err != nil {
		t.Fatal(err)
	}
	if grant.AccountID != alice {
		t.Fatalf("recovery by Alice's ID went to %s", grant.AccountID)
	}
	if _, err := f.ident.DisableAccount(ctx, alice); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.Resolve(ctx, squatter.Token); err != nil {
		t.Fatalf("disabling Alice by ID ended the account whose login is that ID: %v", err)
	}
}
