package httpapi

import (
	"context"

	"github.com/kisshot/falky/server/internal/api"
)

func (s *server) ListRooms(ctx context.Context, _ api.ListRoomsRequestObject) (api.ListRoomsResponseObject, error) {
	list, err := s.rooms.List(ctx)
	if err != nil {
		return nil, err
	}
	body := api.RoomList{Rooms: make([]api.Room, 0, len(list))}
	for _, r := range list {
		// No occupancy is known yet, so every room is listed empty.
		body.Rooms = append(body.Rooms, api.Room{Id: r.ID, Name: r.Name, Occupancy: []api.Participant{}})
	}
	return api.ListRooms200JSONResponse(body), nil
}
