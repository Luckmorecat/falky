package rooms_test

import (
	"errors"
	"path/filepath"
	"regexp"
	"slices"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
)

// openDB opens the database at path and applies the rooms migrations.
func openDB(t *testing.T, path string) *platform.DB {
	t.Helper()
	ms, err := platform.LoadMigrations(rooms.Migrations())
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

func newService(t *testing.T) *rooms.Service {
	t.Helper()
	return rooms.New(openDB(t, filepath.Join(t.TempDir(), "falky.db")))
}

func create(t *testing.T, s *rooms.Service, name string) rooms.Room {
	t.Helper()
	r, err := s.Create(t.Context(), name)
	if err != nil {
		t.Fatalf("Create(%q): %v", name, err)
	}
	return r
}

func list(t *testing.T, s *rooms.Service) []rooms.Room {
	t.Helper()
	got, err := s.List(t.Context())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	return got
}

var ulidPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

func TestCreatedRoomsAreListedInCreationOrder(t *testing.T) {
	s := newService(t)
	if got := list(t, s); len(got) != 0 {
		t.Fatalf("List before any room = %+v, want none", got)
	}
	lounge := create(t, s, "  Lounge ")
	if !ulidPattern.MatchString(lounge.ID) || lounge.Name != "Lounge" {
		t.Errorf("Create = %+v, want a ULID and the trimmed name Lounge", lounge)
	}
	games := create(t, s, "Games")
	if got, want := list(t, s), []rooms.Room{lounge, games}; !slices.Equal(got, want) {
		t.Errorf("List = %+v, want %+v", got, want)
	}
}

func TestRoomsSurviveReopeningTheDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "falky.db")
	db := openDB(t, path)
	lounge := create(t, rooms.New(db), "Lounge")
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := list(t, rooms.New(openDB(t, path))); !slices.Equal(got, []rooms.Room{lounge}) {
		t.Errorf("List after reopening = %+v, want %+v", got, lounge)
	}
}

func TestRoomNamesFollowTheNameRules(t *testing.T) {
	s := newService(t)
	lounge := create(t, s, "Lounge")
	for _, name := range []string{"", "   ", "a\x00b", "abcdefghijklmnopqrstuvwxyz0123456"} {
		if _, err := s.Create(t.Context(), name); !errors.Is(err, rooms.ErrInvalidName) {
			t.Errorf("Create(%q) = %v, want ErrInvalidName", name, err)
		}
		if _, err := s.Rename(t.Context(), lounge.ID, name); !errors.Is(err, rooms.ErrInvalidName) {
			t.Errorf("Rename to %q = %v, want ErrInvalidName", name, err)
		}
	}
	if got := list(t, s); !slices.Equal(got, []rooms.Room{lounge}) {
		t.Errorf("List = %+v, want only %+v", got, lounge)
	}
}

func TestRoomNamesAreUniqueComparedAsVisitorNames(t *testing.T) {
	s := newService(t)
	lounge := create(t, s, "Lounge")
	games := create(t, s, "Games")
	for _, name := range []string{"Lounge", " lounge ", "LOUNGE"} {
		if _, err := s.Create(t.Context(), name); !errors.Is(err, rooms.ErrNameTaken) {
			t.Errorf("Create(%q) = %v, want ErrNameTaken", name, err)
		}
		if _, err := s.Rename(t.Context(), games.ID, name); !errors.Is(err, rooms.ErrNameTaken) {
			t.Errorf("Rename Games to %q = %v, want ErrNameTaken", name, err)
		}
	}
	if got := list(t, s); !slices.Equal(got, []rooms.Room{lounge, games}) {
		t.Errorf("List = %+v, want %+v", got, []rooms.Room{lounge, games})
	}
}

func TestRenamingChangesTheListedName(t *testing.T) {
	s := newService(t)
	lounge := create(t, s, "Lounge")
	games := create(t, s, "Games")

	renamed, err := s.Rename(t.Context(), lounge.ID, " Living room ")
	if err != nil || renamed != (rooms.Room{ID: lounge.ID, Name: "Living room"}) {
		t.Fatalf("Rename = %+v, %v, want Living room under the same ID", renamed, err)
	}
	// A room may change the case of its own name, and keep it as it is.
	for _, name := range []string{"LIVING ROOM", "LIVING ROOM"} {
		if renamed, err = s.Rename(t.Context(), lounge.ID, name); err != nil || renamed.Name != name {
			t.Errorf("Rename to %q = %+v, %v, want it renamed", name, renamed, err)
		}
	}
	if got, want := list(t, s), []rooms.Room{renamed, games}; !slices.Equal(got, want) {
		t.Errorf("List = %+v, want %+v", got, want)
	}
	// The old name is free again.
	create(t, s, "Lounge")
}

func TestRenamingAnUnknownRoomFails(t *testing.T) {
	s := newService(t)
	create(t, s, "Lounge")
	for _, name := range []string{"Games", "Lounge"} {
		if _, err := s.Rename(t.Context(), "01JBX6Z8Q3M5W2K7R9T4V1C0DE", name); !errors.Is(err, rooms.ErrNotFound) {
			t.Errorf("Rename unknown room to %q = %v, want ErrNotFound", name, err)
		}
	}
}

func TestAuthorizeAllowsEverythingInAKnownRoomOnly(t *testing.T) {
	s := newService(t)
	lounge := create(t, s, "Lounge")
	bob := identity.Visitor{ID: "01JBX6Z8Q3M5W2K7R9T4V1C0DE", Name: "Bob"}
	for _, action := range []rooms.Action{rooms.ReadMessages, rooms.PostMessage, rooms.JoinVoice} {
		if err := s.Authorize(t.Context(), bob, lounge.ID, action); err != nil {
			t.Errorf("Authorize(%v) in Lounge = %v, want allowed", action, err)
		}
		if err := s.Authorize(t.Context(), bob, "01JBX6Z8Q3M5W2K7R9T4V1C0DF", action); !errors.Is(err, rooms.ErrNotFound) {
			t.Errorf("Authorize(%v) in an unknown room = %v, want ErrNotFound", action, err)
		}
	}
}
