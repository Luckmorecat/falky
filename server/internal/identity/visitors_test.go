package identity_test

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"path/filepath"
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

// fixture is a Service over a fresh database with its access link created,
// on a clock the test controls.
type fixture struct {
	db     *platform.DB
	ident  *identity.Service
	clock  *clock
	secret string
}

func newFixture(t *testing.T, path string) fixture {
	t.Helper()
	db := openDB(t, path)
	c := &clock{now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
	ident := identity.New(db, "https://falky.example", identity.WithClock(c.Now))
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatalf("EnsureLink: %v", err)
	}
	link, err := ident.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	return fixture{db: db, ident: ident, clock: c, secret: strings.TrimPrefix(link, "https://falky.example/#k=")}
}

func (f fixture) enter(t *testing.T, name string) (identity.Visitor, string) {
	t.Helper()
	v, token, err := f.ident.Enter(t.Context(), f.secret, name)
	if err != nil {
		t.Fatalf("Enter(%q): %v", name, err)
	}
	return v, token
}

var ulidPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

func TestEnteringCreatesAVisitorTheTokenResolvesTo(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	v, token := f.enter(t, "  Bob ")
	if !ulidPattern.MatchString(v.ID) || v.Name != "Bob" {
		t.Errorf("Enter = %+v, want a ULID and the trimmed name Bob", v)
	}
	if token == "" {
		t.Fatal("Enter returned an empty token")
	}
	got, err := f.ident.Resolve(t.Context(), token)
	if err != nil || got != v {
		t.Errorf("Resolve = %+v, %v, want %+v", got, err, v)
	}
}

func TestEnteringWithAWrongSecretIsRefused(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	for _, secret := range []string{"", "wrong", f.secret + "x", strings.ToLower(f.secret)} {
		// The name is invalid too: a wrong secret is reported first.
		for _, name := range []string{"Bob", ""} {
			if _, token, err := f.ident.Enter(t.Context(), secret, name); !errors.Is(err, identity.ErrWrongSecret) || token != "" {
				t.Errorf("Enter(%q, %q) = token %q, %v; want ErrWrongSecret and no token", secret, name, token, err)
			}
		}
	}
	var visitors int
	if err := f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM visitors").Scan(&visitors); err != nil {
		t.Fatalf("count visitors: %v", err)
	}
	if visitors != 0 {
		t.Errorf("%d visitors after wrong secrets, want 0", visitors)
	}
}

func TestTokensAreStoredOnlyAsHashesWithTheirGeneration(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	v, token := f.enter(t, "Bob")
	var hash []byte
	var visitorID string
	var generation int
	if err := f.db.Read().QueryRowContext(t.Context(),
		"SELECT token_hash, visitor_id, generation FROM visitor_tokens",
	).Scan(&hash, &visitorID, &generation); err != nil {
		t.Fatalf("query visitor_tokens: %v", err)
	}
	if want := sha256.Sum256([]byte(token)); string(hash) != string(want[:]) {
		t.Errorf("token_hash = %x, want the SHA-256 of the token", hash)
	}
	if visitorID != v.ID || generation != 1 {
		t.Errorf("token row = visitor %s, generation %d; want %s, 1", visitorID, generation, v.ID)
	}
}

func TestResolveRefusesUnknownTokens(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	_, token := f.enter(t, "Bob")
	for _, unknown := range []string{"", "nonsense", token + "x"} {
		if v, err := f.ident.Resolve(t.Context(), unknown); !errors.Is(err, identity.ErrNoVisitor) {
			t.Errorf("Resolve(%q) = %+v, %v, want ErrNoVisitor", unknown, v, err)
		}
	}
}

// replaceLink moves the access link to the next generation, as rotating it
// does.
func replaceLink(t *testing.T, db *platform.DB) {
	t.Helper()
	if err := db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "UPDATE access SET link_secret = 'replaced', generation = generation + 1")
		return err
	}); err != nil {
		t.Fatalf("replace link: %v", err)
	}
}

func TestAccessEndsWhenTheLinkIsReplaced(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	v, token := f.enter(t, "Bob")
	if got, err := f.ident.Visitor(t.Context(), v.ID); err != nil || got != v {
		t.Fatalf("Visitor before replacing the link = %+v, %v, want %+v", got, err, v)
	}

	replaceLink(t, f.db)
	if got, err := f.ident.Resolve(t.Context(), token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Errorf("Resolve after replacing the link = %+v, %v, want ErrNoVisitor", got, err)
	}
	if got, err := f.ident.Visitor(t.Context(), v.ID); !errors.Is(err, identity.ErrNoVisitor) {
		t.Errorf("Visitor after replacing the link = %+v, %v, want ErrNoVisitor", got, err)
	}
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "Ann"); !errors.Is(err, identity.ErrWrongSecret) {
		t.Errorf("Enter with the replaced secret = %v, want ErrWrongSecret", err)
	}
}

func TestVisitorHasTheCurrentNameAndFailsForUnknownVisitors(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	v, _ := f.enter(t, "Bob")
	if _, err := f.ident.Rename(t.Context(), v.ID, "Robert"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if got, err := f.ident.Visitor(t.Context(), v.ID); err != nil || got != (identity.Visitor{ID: v.ID, Name: "Robert"}) {
		t.Errorf("Visitor after renaming = %+v, %v, want Robert", got, err)
	}
	if got, err := f.ident.Visitor(t.Context(), "01JBX6Z8Q3M5W2K7R9T4V1C0DE"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Errorf("Visitor(unknown) = %+v, %v, want ErrNoVisitor", got, err)
	}
}

func TestAReturningTokenResolvesToTheSameVisitorAfterReopening(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	v, token := newFixture(t, path).enter(t, "Bob")

	reopened := identity.New(openDB(t, path), "https://falky.example")
	if got, err := reopened.Resolve(t.Context(), token); err != nil || got != v {
		t.Errorf("Resolve after reopening = %+v, %v, want %+v", got, err, v)
	}
}

func TestEnteringReservesTheNameForAMinute(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	f.enter(t, "Bob")

	f.clock.Advance(59 * time.Second)
	for _, name := range []string{"Bob", " bob ", "BOB"} {
		if _, _, err := f.ident.Enter(t.Context(), f.secret, name); !errors.Is(err, identity.ErrNameTaken) {
			t.Errorf("Enter(%q) 59 s after Bob entered = %v, want ErrNameTaken", name, err)
		}
	}
	if v, _, err := f.ident.Enter(t.Context(), f.secret, "Bobby"); err != nil || v.Name != "Bobby" {
		t.Errorf("Enter(Bobby) = %+v, %v, want a visitor named Bobby", v, err)
	}

	f.clock.Advance(time.Second)
	if v, _, err := f.ident.Enter(t.Context(), f.secret, "bob"); err != nil || v.Name != "bob" {
		t.Errorf("Enter(bob) 60 s after Bob entered = %+v, %v, want a visitor named bob", v, err)
	}
}

func TestInvalidNamesAreRefused(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	bob, _ := f.enter(t, "Bob")
	for _, name := range []string{
		"",
		" \t\n ",
		strings.Repeat("a", 33),
		strings.Repeat("ж", 33),
		"Bo\x00b",
		"Bo\nb",
		"Bo\u0085b",
		"Bo\u202eb",
		"Bo\xffb",
	} {
		if _, _, err := f.ident.Enter(t.Context(), f.secret, name); !errors.Is(err, identity.ErrInvalidName) {
			t.Errorf("Enter(%q) = %v, want ErrInvalidName", name, err)
		}
		if _, err := f.ident.Rename(t.Context(), bob.ID, name); !errors.Is(err, identity.ErrInvalidName) {
			t.Errorf("Rename(%q) = %v, want ErrInvalidName", name, err)
		}
	}
	for _, name := range []string{strings.Repeat("ж", 32), " " + strings.Repeat("a", 32) + " ", "Анна-Мария 🎧"} {
		f.clock.Advance(time.Minute) // let earlier reservations lapse
		if _, _, err := f.ident.Enter(t.Context(), f.secret, name); err != nil {
			t.Errorf("Enter(%q) = %v, want it allowed", name, err)
		}
	}
}

func TestRenamingChangesTheNameAndMovesTheReservation(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	bob, token := f.enter(t, "Bob")
	ann, _ := f.enter(t, "Ann")

	if _, err := f.ident.Rename(t.Context(), bob.ID, " ann "); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Rename to Ann's reserved name = %v, want ErrNameTaken", err)
	}
	if v, err := f.ident.Rename(t.Context(), bob.ID, "BOB"); err != nil || v.Name != "BOB" {
		t.Errorf("Rename to own name in other case = %+v, %v, want BOB", v, err)
	}
	renamed, err := f.ident.Rename(t.Context(), bob.ID, " Rob ")
	if err != nil || renamed != (identity.Visitor{ID: bob.ID, Name: "Rob"}) {
		t.Fatalf("Rename to Rob = %+v, %v, want %s named Rob", renamed, err, bob.ID)
	}
	if got, err := f.ident.Resolve(t.Context(), token); err != nil || got != renamed {
		t.Errorf("Resolve after renaming = %+v, %v, want %+v", got, err, renamed)
	}

	// The reservation followed the visitor: Rob is held, Bob is free.
	if _, err := f.ident.Rename(t.Context(), ann.ID, "rob"); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Rename to Rob while reserved = %v, want ErrNameTaken", err)
	}
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "Bob"); err != nil {
		t.Errorf("Enter(Bob) after Bob was renamed = %v, want it allowed", err)
	}
}

func TestRenamingAnUnknownVisitorFails(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	if _, err := f.ident.Rename(t.Context(), "01JBX6Z8Q3M5W2K7R9T4V1C0DE", "Bob"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Errorf("Rename(unknown) = %v, want ErrNoVisitor", err)
	}
}

// connect counts a connection of v and fails the test unless Connect allows
// it. The returned func ends the connection, saying whether it opened.
func (f fixture) connect(t *testing.T, v identity.Visitor) func(opened bool) {
	t.Helper()
	disconnect, err := f.ident.Connect(t.Context(), v.ID)
	if err != nil {
		t.Fatalf("Connect(%s): %v", v.Name, err)
	}
	return disconnect
}

func TestAConnectedVisitorHoldsTheNameUntilTheLastConnectionEnds(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	bob, _ := f.enter(t, "Bob")
	tab1 := f.connect(t, bob)
	tab2 := f.connect(t, bob)

	// Connecting took over the reservation, so it does not lapse.
	f.clock.Advance(time.Hour)
	if _, _, err := f.ident.Enter(t.Context(), f.secret, " bob "); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Enter(bob) while Bob is connected = %v, want ErrNameTaken", err)
	}
	ann, _ := f.enter(t, "Ann")
	if _, err := f.ident.Rename(t.Context(), ann.ID, "BOB"); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Rename to BOB while Bob is connected = %v, want ErrNameTaken", err)
	}

	tab1(true)
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "bob"); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Enter(bob) while one of Bob's connections is left = %v, want ErrNameTaken", err)
	}
	tab2(true)
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "bob"); err != nil {
		t.Errorf("Enter(bob) after Bob's last connection ended = %v, want it allowed", err)
	}
}

func TestTheNameIsFreeOnceTheFirstConnectionEndsWithinTheReservation(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	bob, _ := f.enter(t, "Bob")
	f.connect(t, bob)(true)
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "bob"); err != nil {
		t.Errorf("Enter(bob) after Bob connected and left = %v, want it allowed", err)
	}
}

func TestAConnectionThatNeverOpenedLeavesTheReservation(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	bob, _ := f.enter(t, "Bob")
	f.connect(t, bob)(false)
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "bob"); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Enter(bob) after Bob's upgrade failed = %v, want ErrNameTaken", err)
	}
	f.clock.Advance(time.Minute)
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "bob"); err != nil {
		t.Errorf("Enter(bob) once the reservation lapsed = %v, want it allowed", err)
	}
}

func TestAConnectedVisitorTakesTheirNameAlongWhenRenaming(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	bob, _ := f.enter(t, "Bob")
	disconnect := f.connect(t, bob)
	f.clock.Advance(time.Hour)
	if _, err := f.ident.Rename(t.Context(), bob.ID, "Rob"); err != nil {
		t.Fatalf("Rename to Rob: %v", err)
	}
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "bob"); err != nil {
		t.Errorf("Enter(bob) after Bob renamed = %v, want it allowed", err)
	}
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "rob"); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Enter(rob) while Rob is connected = %v, want ErrNameTaken", err)
	}
	disconnect(true)
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "rob"); err != nil {
		t.Errorf("Enter(rob) after Rob left = %v, want it allowed", err)
	}
}

func TestAReturningVisitorWhoseNameIsTakenCannotConnectUntilTheyRename(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	x, _ := f.enter(t, "Bob")
	f.connect(t, x)(true)
	y, _ := f.enter(t, "bob")
	f.connect(t, y)

	if !f.ident.NameTaken(x) {
		t.Error("NameTaken(X) while Y is connected as bob = false, want true")
	}
	if f.ident.NameTaken(y) {
		t.Error("NameTaken(Y) = true, want false: Y holds the name")
	}
	if _, err := f.ident.Connect(t.Context(), x.ID); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Connect(X) = %v, want ErrNameTaken", err)
	}
	if _, err := f.ident.Rename(t.Context(), x.ID, "BOB"); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("X renaming to own name in other case = %v, want ErrNameTaken", err)
	}

	renamed, err := f.ident.Rename(t.Context(), x.ID, "Rob")
	if err != nil {
		t.Fatalf("Rename X to Rob: %v", err)
	}
	if f.ident.NameTaken(renamed) {
		t.Error("NameTaken(X) after renaming = true, want false")
	}
	f.connect(t, renamed)
}

func TestAReservationFromEnteringKeepsAReturningVisitorOut(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	x, _ := f.enter(t, "Bob")
	f.clock.Advance(time.Minute)
	f.enter(t, "bob")

	if _, err := f.ident.Connect(t.Context(), x.ID); !errors.Is(err, identity.ErrNameTaken) {
		t.Errorf("Connect(X) while bob is reserved = %v, want ErrNameTaken", err)
	}
	f.clock.Advance(time.Minute)
	f.connect(t, x)
}

func TestOnlyOneOfTwoVisitorsWithTheSameNameConnects(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	x, _ := f.enter(t, "Bob")
	f.clock.Advance(time.Minute)
	y, _ := f.enter(t, "bob")
	f.clock.Advance(time.Minute)

	errs := make(chan error, 2)
	for _, v := range []identity.Visitor{x, y} {
		go func() {
			_, err := f.ident.Connect(t.Context(), v.ID)
			errs <- err
		}()
	}
	var allowed, refused int
	for range 2 {
		switch err := <-errs; {
		case err == nil:
			allowed++
		case errors.Is(err, identity.ErrNameTaken):
			refused++
		default:
			t.Fatalf("Connect: %v", err)
		}
	}
	if allowed != 1 || refused != 1 {
		t.Errorf("Connect allowed %d and refused %d of two visitors named Bob, want 1 and 1", allowed, refused)
	}
}

func TestConnectingAnUnknownVisitorFails(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	if _, err := f.ident.Connect(t.Context(), "01JBX6Z8Q3M5W2K7R9T4V1C0DE"); !errors.Is(err, identity.ErrNoVisitor) {
		t.Errorf("Connect(unknown) = %v, want ErrNoVisitor", err)
	}
}
