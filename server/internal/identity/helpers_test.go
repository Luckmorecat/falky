package identity_test

import (
	"context"
	"io"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

// clock is a time source the test moves by hand.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// cheap keeps hashing fast in tests; production uses DefaultPasswordCost.
var cheap = identity.WithPasswordCost(identity.PasswordCost{Time: 1, MemoryKiB: 64})

// accessPassword is the access password every fixture starts with.
const accessPassword = "shared secret phrase"

// password is the password test accounts register with.
const password = "correct horse battery"

// openDB opens the database file at path with identity's migrations applied.
func openDB(t *testing.T, path string) *platform.DB {
	t.Helper()
	ms, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := platform.OpenDB(t.Context(), path, platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return db
}

// fixture is a Service over a fresh database whose access password is set,
// with a pass for it, on a clock the test controls.
type fixture struct {
	db    *platform.DB
	ident *identity.Service
	clock *clock
	pass  string
}

func newFixture(t *testing.T, path string, opts ...identity.Option) fixture {
	t.Helper()
	db := openDB(t, path)
	c := &clock{now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
	ident := identity.New(db, "https://falky.example", append([]identity.Option{cheap, identity.WithClock(c.Now)}, opts...)...)
	if err := ident.SetAccessPassword(t.Context(), accessPassword); err != nil {
		t.Fatalf("SetAccessPassword: %v", err)
	}
	pass, err := ident.PassAccess(t.Context(), accessPassword)
	if err != nil {
		t.Fatalf("PassAccess: %v", err)
	}
	return fixture{db: db, ident: ident, clock: c, pass: pass}
}

var notLogin = regexp.MustCompile(`[^a-z0-9]+`)

// loginFor turns a test name into a valid login: "Visitor 3" is visitor-3.
func loginFor(name string) string {
	login := strings.Trim(notLogin.ReplaceAllString(strings.ToLower(name), "-"), "-")
	for len(login) < identity.MinLoginLength {
		login += "x"
	}
	return login
}

// register registers name on service with a login made from it and password,
// and fails the test unless it succeeds.
func register(t *testing.T, service *identity.Service, pass, name string) identity.Enrollment {
	t.Helper()
	e, err := service.Register(t.Context(), identity.RegistrationInput{AccessToken: pass, Login: loginFor(name), Password: password, Name: name})
	if err != nil {
		t.Fatalf("Register(%q): %v", name, err)
	}
	return e
}

// enter registers an account named name and returns its identity and session token.
func (f fixture) enter(t *testing.T, name string) (identity.Visitor, string) {
	t.Helper()
	e := register(t, f.ident, f.pass, name)
	return e.Session.Visitor, e.Token
}

var ulidPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

// enterOn registers name on service and returns its identity and token,
// leaving the error to the caller, which may run concurrently.
func enterOn(_ *testing.T, service *identity.Service, pass, name string) (identity.Visitor, string, error) {
	e, err := service.Register(context.Background(), identity.RegistrationInput{AccessToken: pass, Login: loginFor(name), Password: password, Name: name})
	return e.Session.Visitor, e.Token, err
}
