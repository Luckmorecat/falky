package identity_test

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/kisshot/falky/server/internal/platform"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestVisitorColourIsPersistentAndChangesOnlyWhenSaved(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	f := newFixture(t, path)
	v, token := f.enter(t, "Bob")
	if v.Colour.VisitorID != v.ID || v.Colour.Revision != 1 || v.Colour.Palette == "" {
		t.Fatalf("initial colour = %+v", v.Colour)
	}
	saved, err := f.ident.SetColour(t.Context(), v.ID, "ruby")
	if err != nil || saved.Palette != "ruby" || saved.Revision != 2 {
		t.Fatalf("save = %+v, %v", saved, err)
	}
	reopened := identity.New(openDB(t, path), "https://falky.example")
	if err := reopened.InitializeColours(t.Context()); err != nil {
		t.Fatal(err)
	}
	got, err := reopened.Resolve(t.Context(), token)
	if err != nil || got.Colour != saved {
		t.Fatalf("reopened = %+v, %v; want %+v", got, err, saved)
	}
	renamed, err := reopened.Rename(t.Context(), v.ID, "Robert")
	if err != nil || renamed.Colour != saved {
		t.Fatalf("renamed = %+v, %v", renamed, err)
	}
}

// Controlling only the random index proves every candidate can be sampled,
// without flaky frequency assertions or duplicating the allocation algorithm.
func TestAutomaticColourSamplesEveryUnusedPaletteUniformly(t *testing.T) {
	expected := []string{"sky", "apricot", "lagoon", "rose", "violet", "amber", "moss", "coral", "indigo", "plum", "sunset", "aurora", "lime", "clay", "ocean", "ruby"}
	for index, want := range expected {
		t.Run(want, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			service := identity.New(f.db, "https://falky.example", cheap, identity.WithColourChoice(func(n int) int {
				if n != 16 {
					t.Fatalf("candidate count = %d", n)
				}
				return index
			}))
			visitor, _, err := enterOn(t, service, f.pass, "Bob")
			if err != nil || visitor.Colour.Palette != want {
				t.Fatalf("assignment = %+v, %v; want %s", visitor, err, want)
			}
		})
	}
}

func TestConcurrentFirstAssignmentsExhaustUnusedPalettesBeforeReuse(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	var wg sync.WaitGroup
	assigned := make(chan identity.Visitor, 16)
	for n := range 16 {
		wg.Go(func() {
			v, _, err := enterOn(t, f.ident, f.pass, fmt.Sprintf("Visitor %d", n))
			if err != nil {
				t.Error(err)
				return
			}
			assigned <- v
		})
	}
	wg.Wait()
	close(assigned)
	seen := map[string]bool{}
	for v := range assigned {
		if seen[v.Colour.Palette] {
			t.Errorf("duplicate before exhaustion: %s", v.Colour.Palette)
		}
		seen[v.Colour.Palette] = true
	}
	if len(seen) != 16 {
		t.Fatalf("assigned %d distinct palettes", len(seen))
	}
}

func TestExhaustedColoursReuseOfflineAssignmentsAndThenLeastConnectedUse(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	service := identity.New(f.db, "https://falky.example", cheap, identity.WithColourChoice(func(int) int { return 0 }))
	var original []identity.Visitor
	for n := range 16 {
		v, _, err := enterOn(t, service, f.pass, fmt.Sprintf("Visitor %d", n))
		if err != nil {
			t.Fatal(err)
		}
		original = append(original, v)
		service.ColourConnected(v.ID, true)
	}
	// Only ruby is offline. Reuse never changes its original owner's assignment.
	service.ColourConnected(original[15].ID, false)
	reused, _, err := enterOn(t, service, f.pass, "Returning palette")
	if err != nil || reused.Colour.Palette != "ruby" {
		t.Fatalf("offline reuse = %+v, %v", reused, err)
	}
	got, err := service.Colours(t.Context(), []string{original[15].ID})
	if err != nil || len(got) != 1 || got[0] != original[15].Colour {
		t.Fatalf("offline owner changed: %+v, %v", got, err)
	}
	// All palettes connected, with two distinct visitors on ruby. Every other
	// palette is least used and the injected first index chooses sky.
	service.ColourConnected(original[15].ID, true)
	service.ColourConnected(reused.ID, true)
	least, _, err := enterOn(t, service, f.pass, "Least used")
	if err != nil || least.Colour.Palette != "sky" {
		t.Fatalf("least used = %+v, %v", least, err)
	}
	// Manual edits immediately affect allocation counts, never other assignments.
	if _, err := service.SetColour(t.Context(), original[0].ID, "ruby"); err != nil {
		t.Fatal(err)
	}
	vacant, _, err := enterOn(t, service, f.pass, "Vacant connected palette")
	if err != nil || vacant.Colour.Palette != "sky" {
		t.Fatalf("manual count update = %+v, %v", vacant, err)
	}
}

func TestDuplicateManualColoursAreValidAndInvalidChoiceLeavesRevisionUnchanged(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	bob, _ := f.enter(t, "Bob")
	ann, _ := f.enter(t, "Ann")
	saved, err := f.ident.SetColour(t.Context(), bob.ID, ann.Colour.Palette)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.ident.SetColour(t.Context(), bob.ID, "SKY"); !errors.Is(err, identity.ErrInvalidPalette) {
		t.Fatalf("invalid choice = %v", err)
	}
	colours, err := f.ident.Colours(t.Context(), []string{bob.ID, ann.ID})
	if err != nil || len(colours) != 2 || colours[0] != saved || colours[1] != ann.Colour {
		t.Fatalf("colours changed: %+v, %v", colours, err)
	}
	same, err := f.ident.SetColour(t.Context(), bob.ID, saved.Palette)
	if err != nil || same.Revision != saved.Revision+1 {
		t.Fatalf("same palette save = %+v, %v", same, err)
	}
}

func TestHistoricalColourLookupDoesNotRestoreRevokedAccess(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	visitor, token := f.enter(t, "Bob")
	if _, err := f.ident.DisableAccount(t.Context(), visitor.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.ident.InitializeColours(t.Context()); err != nil {
		t.Fatal(err)
	}
	colours, err := f.ident.Colours(t.Context(), []string{visitor.ID, "unknown", visitor.ID})
	if err != nil || len(colours) != 1 || colours[0] != visitor.Colour {
		t.Fatalf("historical lookup = %+v, %v", colours, err)
	}
	if _, err := f.ident.Resolve(t.Context(), token); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("historical token restored: %v", err)
	}
	if _, err := f.ident.Visitor(t.Context(), visitor.ID); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("historical visitor granted access: %v", err)
	}
}

func TestAdditiveMigrationBackfillsEveryIdentityIncludingRevokedAuthors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	legacy := fstest.MapFS{}
	for _, name := range []string{"0001_access.sql", "0002_visitors.sql"} {
		body, err := fs.ReadFile(identity.Migrations(), name)
		if err != nil {
			t.Fatal(err)
		}
		legacy[name] = &fstest.MapFile{Data: body}
	}
	ms, err := platform.LoadMigrations(legacy)
	if err != nil {
		t.Fatal(err)
	}
	db, err := platform.OpenDB(t.Context(), path, platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatal(err)
	}
	// These are the pre-feature database contents, not observations of internals.
	if err := db.Write(t.Context(), func(tx *sql.Tx) error {
		for n := range 20 {
			if _, err := tx.ExecContext(t.Context(), "INSERT INTO visitors (id,name,created_at) VALUES (?,?,?)", fmt.Sprintf("legacy-%02d", n), fmt.Sprintf("Author %d", n), "2026-01-01T00:00:00Z"); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(t.Context(), "INSERT INTO access (id,link_secret,generation,rotated_at) VALUES (1,'current',2,'2026-01-01T00:00:00Z')")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	all, err := platform.LoadMigrations(identity.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), all); err != nil {
		t.Fatal(err)
	}
	service := identity.New(db, "https://falky.example", identity.WithColourChoice(func(int) int { return 0 }))
	if err := service.InitializeColours(t.Context()); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for n := range 20 {
		ids = append(ids, fmt.Sprintf("legacy-%02d", n))
	}
	before, err := service.Colours(t.Context(), ids)
	if err != nil || len(before) != 20 {
		t.Fatalf("historical backfill = %+v, %v", before, err)
	}
	seen := map[string]bool{}
	for _, c := range before[:16] {
		if c.Revision != 1 || seen[c.Palette] {
			t.Fatalf("first assignments = %+v", before)
		}
		seen[c.Palette] = true
	}
	if err := service.InitializeColours(t.Context()); err != nil {
		t.Fatal(err)
	}
	after, err := service.Colours(t.Context(), ids)
	if err != nil || !slices.Equal(before, after) {
		t.Fatalf("repeat initialization changed assignments: %+v, %v", after, err)
	}
	if _, err := service.Visitor(t.Context(), ids[0]); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("historical author gained access: %v", err)
	}
}
