package httpapi

import (
	"context"
	"errors"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/rooms"
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

// maxRooms bounds how many rooms accounts may create between them.
const maxRooms = 50

var (
	roomNameTaken = api.Error{Code: "room_name_taken", Message: "another room has this name"}
	roomsLimited  = api.RateLimitedJSONResponse{Code: "rate_limited", Message: "too many room changes; try again in a minute"}
)

func (s *server) roomChangeAllowed(ctx context.Context) bool {
	return s.roomLimit == nil || s.roomLimit.Allow(currentVisitor(ctx).ID)
}

func (s *server) CreateRoom(ctx context.Context, req api.CreateRoomRequestObject) (api.CreateRoomResponseObject, error) {
	if !s.roomChangeAllowed(ctx) {
		return api.CreateRoom429JSONResponse{RateLimitedJSONResponse: roomsLimited}, nil
	}
	list, err := s.rooms.List(ctx)
	if err != nil {
		return nil, err
	}
	if len(list) >= maxRooms {
		return api.CreateRoom409JSONResponse{Code: "room_limit", Message: "the server has as many rooms as it allows"}, nil
	}
	room, err := s.rooms.Create(ctx, req.Body.Name)
	switch {
	case errors.Is(err, rooms.ErrInvalidName):
		return api.CreateRoom400JSONResponse{InvalidNameJSONResponse: invalidName(err)}, nil
	case errors.Is(err, rooms.ErrNameTaken):
		return api.CreateRoom409JSONResponse(roomNameTaken), nil
	case err != nil:
		return nil, err
	}
	return api.CreateRoom201JSONResponse{Id: room.ID, Name: room.Name, Occupancy: []api.Participant{}}, nil
}

func (s *server) RenameRoom(ctx context.Context, req api.RenameRoomRequestObject) (api.RenameRoomResponseObject, error) {
	if !s.roomChangeAllowed(ctx) {
		return api.RenameRoom429JSONResponse{RateLimitedJSONResponse: roomsLimited}, nil
	}
	room, err := s.rooms.Rename(ctx, req.Id, req.Body.Name)
	switch {
	case errors.Is(err, rooms.ErrNotFound):
		return api.RenameRoom404JSONResponse{RoomNotFoundJSONResponse: roomNotFound}, nil
	case errors.Is(err, rooms.ErrInvalidName):
		return api.RenameRoom400JSONResponse{InvalidNameJSONResponse: invalidName(err)}, nil
	case errors.Is(err, rooms.ErrNameTaken):
		return api.RenameRoom409JSONResponse(roomNameTaken), nil
	case err != nil:
		return nil, err
	}
	return api.RenameRoom200JSONResponse{Id: room.ID, Name: room.Name, Occupancy: participants(s.voice.Occupancy(room.ID))}, nil
}
