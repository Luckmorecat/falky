package identity_test

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

// openDB opens the database file at path with identity's migrations applied.
func openDB(t *testing.T, path string) *platform.DB {
	t.Helper()
	ms, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := platform.OpenDB(t.Context(), path)
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

// The secret is URL-safe and at least 128 bits: 26 or more base32 characters
// (5 bits each) or a longer base64url string.
var linkPattern = regexp.MustCompile(`^https://falky\.example/#k=([A-Za-z0-9_-]{26,})$`)

func TestEnsureLinkCreatesTheLinkOnceAndKeepsIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	ident := identity.New(openDB(t, path), "https://falky.example")

	if _, err := ident.Link(t.Context()); !errors.Is(err, identity.ErrNoLink) {
		t.Fatalf("Link before EnsureLink = %v, want ErrNoLink", err)
	}
	created, err := ident.EnsureLink(t.Context())
	if err != nil || !created {
		t.Fatalf("EnsureLink = %v, %v, want created", created, err)
	}
	link, err := ident.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	if !linkPattern.MatchString(link) {
		t.Fatalf("Link = %q, want https://falky.example/#k=<URL-safe secret of 128 bits or more>", link)
	}

	created, err = ident.EnsureLink(t.Context())
	if err != nil || created {
		t.Fatalf("second EnsureLink = %v, %v, want not created", created, err)
	}
	if again, err := ident.Link(t.Context()); err != nil || again != link {
		t.Errorf("Link after second EnsureLink = %q, %v, want %q", again, err, link)
	}
}

func TestTheLinkSurvivesReopeningTheDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	first := identity.New(openDB(t, path), "https://falky.example")
	if _, err := first.EnsureLink(t.Context()); err != nil {
		t.Fatalf("EnsureLink: %v", err)
	}
	link, err := first.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}

	second := identity.New(openDB(t, path), "https://falky.example")
	if created, err := second.EnsureLink(t.Context()); err != nil || created {
		t.Fatalf("EnsureLink after reopening = %v, %v, want not created", created, err)
	}
	if again, err := second.Link(t.Context()); err != nil || again != link {
		t.Errorf("Link after reopening = %q, %v, want %q", again, err, link)
	}
}

func TestEachDatabaseGetsItsOwnSecret(t *testing.T) {
	links := map[string]bool{}
	for range 3 {
		ident := identity.New(openDB(t, filepath.Join(t.TempDir(), "falky.db")), "https://falky.example")
		if _, err := ident.EnsureLink(t.Context()); err != nil {
			t.Fatalf("EnsureLink: %v", err)
		}
		link, err := ident.Link(t.Context())
		if err != nil {
			t.Fatalf("Link: %v", err)
		}
		links[link] = true
	}
	if len(links) != 3 {
		t.Errorf("three databases got %d distinct links, want 3", len(links))
	}
}

func TestTheAccessRowStartsAtTheFirstGeneration(t *testing.T) {
	db := openDB(t, filepath.Join(t.TempDir(), "falky.db"))
	if _, err := identity.New(db, "https://falky.example").EnsureLink(t.Context()); err != nil {
		t.Fatalf("EnsureLink: %v", err)
	}
	var rows, generation int
	var rotatedAt string
	if err := db.Read().QueryRowContext(t.Context(),
		"SELECT count(*), max(generation), max(rotated_at) FROM access",
	).Scan(&rows, &generation, &rotatedAt); err != nil {
		t.Fatalf("query access: %v", err)
	}
	if rows != 1 || generation != 1 || !strings.HasSuffix(rotatedAt, "Z") {
		t.Errorf("access = %d rows, generation %d, rotated_at %q; want 1 row, generation 1, a UTC time", rows, generation, rotatedAt)
	}
}

func TestRotatingTheLinkReplacesTheSecretAndStartsTheNextGeneration(t *testing.T) {
	db := openDB(t, filepath.Join(t.TempDir(), "falky.db"))
	ident := identity.New(db, "https://falky.example")
	if _, err := ident.EnsureLink(t.Context()); err != nil {
		t.Fatalf("EnsureLink: %v", err)
	}
	first, err := ident.Link(t.Context())
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	var rotatedBefore string
	if err := db.Read().QueryRowContext(t.Context(), "SELECT rotated_at FROM access").Scan(&rotatedBefore); err != nil {
		t.Fatalf("query access: %v", err)
	}
	time.Sleep(2 * time.Millisecond) // rotated_at has millisecond precision

	rotated, err := ident.Rotate(t.Context())
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if rotated == first || !strings.HasPrefix(rotated, "https://falky.example/#k=") {
		t.Errorf("Rotate = %q, want a new link on the public origin (was %q)", rotated, first)
	}
	if current, err := ident.Link(t.Context()); err != nil || current != rotated {
		t.Errorf("Link after Rotate = %q, %v, want %q", current, err, rotated)
	}
	var rows, generation int
	var rotatedAt string
	if err := db.Read().QueryRowContext(t.Context(),
		"SELECT count(*), max(generation), max(rotated_at) FROM access",
	).Scan(&rows, &generation, &rotatedAt); err != nil {
		t.Fatalf("query access: %v", err)
	}
	if rows != 1 || generation != 2 || rotatedAt <= rotatedBefore || !strings.HasSuffix(rotatedAt, "Z") {
		t.Errorf("access = %d rows, generation %d, rotated_at %q; want 1 row, generation 2, a UTC time after %q",
			rows, generation, rotatedAt, rotatedBefore)
	}
}

func TestRotateFailsBeforeTheLinkIsCreated(t *testing.T) {
	db := openDB(t, filepath.Join(t.TempDir(), "falky.db"))
	if link, err := identity.New(db, "https://falky.example").Rotate(t.Context()); !errors.Is(err, identity.ErrNoLink) {
		t.Errorf("Rotate without a link = %q, %v, want ErrNoLink", link, err)
	}
}
