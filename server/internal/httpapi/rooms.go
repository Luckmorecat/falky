package httpapi

import (
	"context"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/voice"
)

func (s *server) ListRooms(ctx context.Context, _ api.ListRoomsRequestObject) (api.ListRoomsResponseObject, error) {
	list, err := s.rooms.List(ctx)
	if err != nil {
		return nil, err
	}
	body := api.RoomList{Rooms: make([]api.Room, 0, len(list))}
	for _, r := range list {
		body.Rooms = append(body.Rooms, api.Room{Id: r.ID, Name: r.Name, Occupancy: participants(s.voice.Occupancy(r.ID))})
	}
	return api.ListRooms200JSONResponse(body), nil
}

// participants is occupancy as the contract has it, an empty list when no one
// is in the room's voice.
func participants(occupancy []voice.Occupant) []api.Participant {
	ps := make([]api.Participant, 0, len(occupancy))
	for _, v := range occupancy {
		ps = append(ps, api.Participant{ConnectionId: v.ConnectionID, VisitorId: v.ID, Name: v.Name})
	}
	return ps
}
