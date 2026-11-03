package httpapi

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/kisshot/falky/server/internal/api"
)

func TestListingRoomsNeedsAVisitor(t *testing.T) {
	p := startPublic(t, 10)
	if _, err := p.rooms.Create(t.Context(), "Lounge"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	res, err := p.browser(t).ListRoomsWithResponse(t.Context())
	if err != nil {
		t.Fatalf("ListRooms: %v", err)
	}
	wantError(t, "ListRooms without a cookie", res.StatusCode(), res.Body, http.StatusUnauthorized, "visitor_required")
	if strings.Contains(string(res.Body), "Lounge") {
		t.Errorf("ListRooms without a cookie = %s, want no room in it", res.Body)
	}
}

func TestListingRoomsReturnsEveryRoomWithItsOccupancy(t *testing.T) {
	p := startPublic(t, 10)
	b := p.browser(t)
	p.enter(t, b, "Bob")

	res, err := b.ListRoomsWithResponse(t.Context())
	if err != nil {
		t.Fatalf("ListRooms: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil || len(res.JSON200.Rooms) != 0 ||
		!strings.Contains(string(res.Body), `"rooms":[]`) {
		t.Fatalf("ListRooms with no rooms = %d %s, want 200 with an empty list", res.StatusCode(), res.Body)
	}

	lounge, err := p.rooms.Create(t.Context(), "Lounge")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	games, err := p.rooms.Create(t.Context(), "Games")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	res, err = b.ListRoomsWithResponse(t.Context())
	if err != nil {
		t.Fatalf("ListRooms: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil {
		t.Fatalf("ListRooms = %d %s, want 200", res.StatusCode(), res.Body)
	}
	want := []api.Room{{Id: lounge.ID, Name: "Lounge"}, {Id: games.ID, Name: "Games"}}
	if !slices.EqualFunc(res.JSON200.Rooms, want, func(a, b api.Room) bool { return a.Id == b.Id && a.Name == b.Name }) {
		t.Errorf("ListRooms = %s, want %+v", res.Body, want)
	}
	if n := strings.Count(string(res.Body), `"occupancy":[]`); n != 2 {
		t.Errorf("ListRooms = %s, want both rooms with an empty occupancy", res.Body)
	}
}
