package identity_test

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

func newTestFixture(t *testing.T) fixture {
	t.Helper()
	return newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
}

func TestTheAccessPasswordAdmitsBrowsersUntilItChanges(t *testing.T) {
	db := openDB(t, filepath.Join(t.TempDir(), "falky.db"))
	c := &clock{now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
	ident := identity.New(db, "https://falky.example", cheap, identity.WithClock(c.Now))
	ctx := t.Context()

	if set, err := ident.AccessPasswordSet(ctx); err != nil || set {
		t.Fatalf("AccessPasswordSet before setting = %v, %v; want false", set, err)
	}
	if _, err := ident.PassAccess(ctx, accessPassword); !errors.Is(err, identity.ErrAccessUnset) {
		t.Fatalf("PassAccess before setting: %v, want ErrAccessUnset", err)
	}
	if err := ident.SetAccessPassword(ctx, "short"); !errors.Is(err, identity.ErrInvalidPassword) {
		t.Fatalf("SetAccessPassword(short): %v, want ErrInvalidPassword", err)
	}
	if err := ident.SetAccessPassword(ctx, accessPassword); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := db.Read().QueryRowContext(ctx, "SELECT password_hash FROM access_password").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, "$argon2id$") || strings.Contains(stored, accessPassword) {
		t.Fatalf("stored access password %q, want an Argon2id hash", stored)
	}
	if _, err := ident.PassAccess(ctx, accessPassword+"!"); !errors.Is(err, identity.ErrWrongAccessPassword) {
		t.Fatalf("PassAccess(wrong): %v, want ErrWrongAccessPassword", err)
	}
	pass, err := ident.PassAccess(ctx, accessPassword)
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", "unknown"} {
		if passed, err := ident.AccessPassed(ctx, token); err != nil || passed {
			t.Fatalf("AccessPassed(%q) = %v, %v; want false", token, passed, err)
		}
	}
	if passed, err := ident.AccessPassed(ctx, pass); err != nil || !passed {
		t.Fatalf("AccessPassed(pass) = %v, %v; want true", passed, err)
	}

	account := register(t, ident, pass, "Ann")
	if err := ident.SetAccessPassword(ctx, "another shared secret"); err != nil {
		t.Fatal(err)
	}
	if passed, _ := ident.AccessPassed(ctx, pass); passed {
		t.Fatal("a pass for the old access password still admits")
	}
	if _, err := ident.Resolve(ctx, account.Token); err != nil {
		t.Fatalf("changing the access password ended a signed-in session: %v", err)
	}

	next, err := ident.PassAccess(ctx, "another shared secret")
	if err != nil {
		t.Fatal(err)
	}
	c.Advance(identity.AccessPassTTL)
	if passed, _ := ident.AccessPassed(ctx, next); passed {
		t.Fatal("an access pass outlived AccessPassTTL")
	}
}

func TestRegisteringNeedsTheAccessPassBeforeAnythingElse(t *testing.T) {
	f := newTestFixture(t)
	_, err := f.ident.Register(t.Context(), identity.RegistrationInput{AccessToken: "forged", Login: "!", Password: "x", Name: ""})
	if !errors.Is(err, identity.ErrAccessRequired) {
		t.Fatalf("Register without a pass: %v, want ErrAccessRequired", err)
	}
}

func TestRegisteringChecksLoginPasswordAndName(t *testing.T) {
	f := newTestFixture(t)
	register(t, f.ident, f.pass, "Ann")
	for _, tc := range []struct {
		login, password, name string
		want                  error
	}{
		{"ab", password, "Bob", identity.ErrInvalidLogin},
		{"-bob", password, "Bob", identity.ErrInvalidLogin},
		{"bob smith", password, "Bob", identity.ErrInvalidLogin},
		{"боб", password, "Bob", identity.ErrInvalidLogin},
		{strings.Repeat("b", identity.MaxLoginLength+1), password, "Bob", identity.ErrInvalidLogin},
		{"bob", "seven77", "Bob", identity.ErrInvalidPassword},
		{"bob", strings.Repeat("p", identity.MaxPasswordLength+1), "Bob", identity.ErrInvalidPassword},
		{"bob", password, "   ", identity.ErrInvalidName},
		{" ANN ", password, "Bob", identity.ErrLoginTaken},
		{"bob", password, " ann ", identity.ErrNameTaken},
	} {
		_, err := f.ident.Register(t.Context(), identity.RegistrationInput{AccessToken: f.pass, Login: tc.login, Password: tc.password, Name: tc.name})
		if !errors.Is(err, tc.want) {
			t.Errorf("Register(%q, %q, %q): %v, want %v", tc.login, tc.password, tc.name, err, tc.want)
		}
	}
	e, err := f.ident.Register(t.Context(), identity.RegistrationInput{AccessToken: f.pass, Login: " Bob.Smith_2 ", Password: "        ", Name: "Bob"})
	if err != nil {
		t.Fatalf("Register with a valid login and an eight-space password: %v", err)
	}
	if _, err := f.ident.Login(t.Context(), f.pass, "bob.smith_2", "        "); err != nil {
		t.Fatalf("Login with the cleaned login: %v", err)
	}
	if e.Session.Visitor.Name != "Bob" {
		t.Fatalf("name = %q, want Bob", e.Session.Visitor.Name)
	}
}

func TestRegisteringSignsInAndStoresOnlyHashes(t *testing.T) {
	f := newTestFixture(t)
	e := register(t, f.ident, f.pass, "Ann")
	if !ulidPattern.MatchString(e.Session.Visitor.ID) {
		t.Fatalf("identity ID %q is not a ULID", e.Session.Visitor.ID)
	}
	if e.Session.Kind != identity.Account {
		t.Fatalf("kind = %q, want account", e.Session.Kind)
	}
	if want := f.clock.Now().Add(identity.AccountSessionTTL).UTC(); !e.Session.ExpiresAt.Equal(want) {
		t.Fatalf("expires %v, want %v", e.Session.ExpiresAt, want)
	}
	v, err := f.ident.Resolve(t.Context(), e.Token)
	if err != nil || v.ID != e.Session.Visitor.ID {
		t.Fatalf("Resolve = %+v, %v", v, err)
	}

	var stored, login string
	if err := f.db.Read().QueryRowContext(t.Context(), "SELECT password_hash, login_key FROM accounts").Scan(&stored, &login); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stored, "$argon2id$") || strings.Contains(stored, password) || login != "ann" {
		t.Fatalf("stored %q for login %q, want an Argon2id hash for ann", stored, login)
	}
	sum := sha256.Sum256([]byte(e.Token))
	var n int
	if err := f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM sessions WHERE token_hash=?", sum[:]).Scan(&n); err != nil || n != 1 {
		t.Fatalf("sessions by token hash = %d, %v; want 1", n, err)
	}
}

func TestSigningInNeedsThePassAndTheRightPassword(t *testing.T) {
	f := newTestFixture(t)
	ann := register(t, f.ident, f.pass, "Ann")
	ctx := t.Context()

	if _, err := f.ident.Login(ctx, "", "ann", password); !errors.Is(err, identity.ErrAccessRequired) {
		t.Fatalf("Login without a pass: %v, want ErrAccessRequired", err)
	}
	for _, tc := range []struct{ login, password string }{{"ann", password + "x"}, {"nobody", password}, {"", ""}} {
		if _, err := f.ident.Login(ctx, f.pass, tc.login, tc.password); !errors.Is(err, identity.ErrWrongCredentials) {
			t.Fatalf("Login(%q, %q): %v, want ErrWrongCredentials", tc.login, tc.password, err)
		}
	}
	signed, err := f.ident.Login(ctx, f.pass, "  ANN ", password)
	if err != nil {
		t.Fatal(err)
	}
	if signed.Session.Visitor.ID != ann.Session.Visitor.ID || signed.Token == ann.Token {
		t.Fatalf("Login = %+v, want a new session of Ann", signed)
	}

	if _, err := f.ident.DisableAccount(ctx, "ann"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.Resolve(ctx, signed.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("a disabled account's session resolves: %v", err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "ann", password+"x"); !errors.Is(err, identity.ErrWrongCredentials) {
		t.Fatalf("Login(disabled, wrong password): %v, want ErrWrongCredentials", err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "ann", password); !errors.Is(err, identity.ErrDisabled) {
		t.Fatalf("Login(disabled): %v, want ErrDisabled", err)
	}
	if err := f.ident.EnableAccount(ctx, ann.Session.Visitor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "ann", password); err != nil {
		t.Fatalf("Login after enabling: %v", err)
	}
}

func TestStoredHashesKeepTheirCost(t *testing.T) {
	f := newTestFixture(t)
	register(t, f.ident, f.pass, "Ann")
	dearer := identity.New(f.db, "https://falky.example", identity.WithPasswordCost(identity.PasswordCost{Time: 2, MemoryKiB: 128}))
	if _, err := dearer.Login(t.Context(), f.pass, "ann", password); err != nil {
		t.Fatalf("Login after the cost changed: %v", err)
	}
}

func TestChangingThePasswordEndsOnlyOtherSessions(t *testing.T) {
	f := newTestFixture(t)
	ctx := t.Context()
	here := register(t, f.ident, f.pass, "Ann")
	there, err := f.ident.Login(ctx, f.pass, "ann", password)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.ChangePassword(ctx, here.Token, password+"x", "a new password"); !errors.Is(err, identity.ErrWrongCredentials) {
		t.Fatalf("ChangePassword(wrong current): %v, want ErrWrongCredentials", err)
	}
	if _, err := f.ident.ChangePassword(ctx, here.Token, password, "short"); !errors.Is(err, identity.ErrInvalidPassword) {
		t.Fatalf("ChangePassword(short): %v, want ErrInvalidPassword", err)
	}
	if _, err := f.ident.ChangePassword(ctx, "unknown", password, "a new password"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("ChangePassword(unknown session): %v, want ErrNoVisitor", err)
	}
	effects, err := f.ident.ChangePassword(ctx, here.Token, password, "a new password")
	if err != nil {
		t.Fatal(err)
	}
	if len(effects.RevokedSessions) != 1 || effects.RevokedSessions[0].ID != there.Session.ID {
		t.Fatalf("revoked %+v, want only the other session", effects.RevokedSessions)
	}
	if _, err := f.ident.Resolve(ctx, here.Token); err != nil {
		t.Fatalf("the changing session ended: %v", err)
	}
	if _, err := f.ident.Resolve(ctx, there.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("another session survived: %v", err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "ann", password); !errors.Is(err, identity.ErrWrongCredentials) {
		t.Fatalf("the old password still signs in: %v", err)
	}
	if _, err := f.ident.Login(ctx, f.pass, "ann", "a new password"); err != nil {
		t.Fatalf("the new password does not sign in: %v", err)
	}
}

func TestLogoutEndsOnlyItsSession(t *testing.T) {
	f := newTestFixture(t)
	ctx := t.Context()
	one := register(t, f.ident, f.pass, "Ann")
	two, err := f.ident.Login(ctx, f.pass, "ann", password)
	if err != nil {
		t.Fatal(err)
	}
	effects, err := f.ident.Logout(ctx, one.Token)
	if err != nil || len(effects.RevokedSessions) != 1 || effects.RevokedSessions[0].ID != one.Session.ID {
		t.Fatalf("Logout = %+v, %v", effects, err)
	}
	if _, err := f.ident.Resolve(ctx, one.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("the logged-out session resolves: %v", err)
	}
	if _, err := f.ident.Resolve(ctx, two.Token); err != nil {
		t.Fatalf("the other session ended: %v", err)
	}
	if _, err := f.ident.Logout(ctx, one.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("Logout again: %v, want ErrNoVisitor", err)
	}
}

func TestSessionsEndNinetyDaysAfterSigningIn(t *testing.T) {
	f := newTestFixture(t)
	e := register(t, f.ident, f.pass, "Ann")
	f.clock.Advance(identity.AccountSessionTTL - time.Second)
	if _, err := f.ident.Resolve(t.Context(), e.Token); err != nil {
		t.Fatalf("a session ended early: %v", err)
	}
	f.clock.Advance(time.Second)
	if _, err := f.ident.Resolve(t.Context(), e.Token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("a session outlived AccountSessionTTL: %v", err)
	}
}

// legacyGuest stores a guest with a session from before accounts replaced
// guests, and returns its identity ID and cookie token.
func legacyGuest(t *testing.T, f fixture, name string) (string, string) {
	t.Helper()
	id, token := "01JBX6Z8Q3M5W2K7R9T4V1C0DE", "legacy-guest-cookie"
	sum := sha256.Sum256([]byte(token))
	now := f.clock.Now().Unix()
	err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
		for _, stmt := range []struct {
			query string
			args  []any
		}{
			{"INSERT INTO access (id, link_secret, generation, rotated_at) VALUES (1, 'old link', 2, '2026-11-01')", nil},
			{"INSERT INTO identities (id, name, created_at) VALUES (?, ?, '2026-11-01')", []any{id, name}},
			{"INSERT INTO sessions (id, token_hash, identity_id, generation, created_at, expires_at) VALUES ('guest-session', ?, ?, 2, ?, ?)", []any{sum[:], id, now, now + 3600}},
		} {
			if _, err := tx.ExecContext(t.Context(), stmt.query, stmt.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.ident.InitializeColours(t.Context()); err != nil {
		t.Fatal(err)
	}
	return id, token
}

func TestALegacyGuestAdmitsNothingButRegisteringKeepsItsIdentity(t *testing.T) {
	f := newTestFixture(t)
	ctx := t.Context()
	id, token := legacyGuest(t, f, "Bob")
	if _, err := f.ident.Resolve(ctx, token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("a guest session resolves: %v", err)
	}
	guest, err := f.ident.LegacyGuest(ctx, token)
	if err != nil || guest.ID != id || guest.Name != "Bob" {
		t.Fatalf("LegacyGuest = %+v, %v", guest, err)
	}
	e, err := f.ident.Register(ctx, identity.RegistrationInput{GuestToken: token, Login: "bob", Password: password, Name: "Bobby"})
	if err != nil {
		t.Fatalf("Register with the guest session and no pass: %v", err)
	}
	if e.Session.Visitor.ID != id || e.Session.Visitor.Name != "Bobby" {
		t.Fatalf("account = %+v, want the guest's identity renamed", e.Session.Visitor)
	}
	if _, err := f.ident.LegacyGuest(ctx, token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("the guest session outlived registering: %v", err)
	}
	if _, err := f.ident.Register(ctx, identity.RegistrationInput{GuestToken: token, Login: "bob2", Password: password, Name: "Bob 2"}); !errors.Is(err, identity.ErrAccessRequired) {
		t.Fatalf("the guest session registered twice: %v", err)
	}
}

func TestRenamingKeepsAccountNamesUnique(t *testing.T) {
	f := newTestFixture(t)
	ann, _ := f.enter(t, "Ann")
	register(t, f.ident, f.pass, "Bob")
	if _, err := f.ident.Rename(t.Context(), ann.ID, " BOB "); !errors.Is(err, identity.ErrNameTaken) {
		t.Fatalf("Rename to another account's name: %v, want ErrNameTaken", err)
	}
	for _, name := range []string{"", "   ", strings.Repeat("x", 33), "a\u202eb"} {
		if _, err := f.ident.Rename(t.Context(), ann.ID, name); !errors.Is(err, identity.ErrInvalidName) {
			t.Fatalf("Rename(%q): %v, want ErrInvalidName", name, err)
		}
	}
	renamed, err := f.ident.Rename(t.Context(), ann.ID, "  ann  ")
	if err != nil || renamed.Name != "ann" {
		t.Fatalf("Rename to a case change of the own name = %+v, %v", renamed, err)
	}
	if _, err := f.ident.Rename(t.Context(), "unknown", "Zed"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("Rename(unknown): %v, want ErrNoVisitor", err)
	}
}

func TestAConnectedAccountHoldsItsNameAcrossConnections(t *testing.T) {
	f := newTestFixture(t)
	ann, _ := f.enter(t, "Ann")
	first, err := f.ident.Connect(t.Context(), ann.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.ident.Connect(t.Context(), ann.ID)
	if err != nil {
		t.Fatal(err)
	}
	first(true)
	second(true)
	if f.ident.NameTaken(ann) {
		t.Fatal("an account's own name is reported taken")
	}
	if _, err := f.ident.Connect(t.Context(), "unknown"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("Connect(unknown): %v, want ErrNoVisitor", err)
	}
}
