package httpapi

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
)

// knockLimits keep a knock a nudge rather than a pager: one per pair of
// identities each knockPairInterval, and a short burst from one caller.
type knockLimits struct {
	pair   *platform.Limiter
	caller *platform.Limiter
}

const (
	knockPairInterval   = 30 * time.Second
	knockCallerBurst    = 5
	knockCallerInterval = 12 * time.Second
)

func newKnockLimits(now func() time.Time) knockLimits {
	return knockLimits{
		pair:   platform.NewLimiter(1, knockPairInterval, now),
		caller: platform.NewLimiter(knockCallerBurst, knockCallerInterval, now),
	}
}

func (s *server) Knock(ctx context.Context, req api.KnockRequestObject) (api.KnockResponseObject, error) {
	caller := currentVisitor(ctx)
	if req.Body == nil || req.Body.VisitorId == "" || req.Body.VisitorId == caller.ID {
		return api.Knock400JSONResponse{Code: "invalid_request", Message: "name someone else to knock"}, nil
	}
	err := s.rooms.Authorize(ctx, caller, req.Id, rooms.ReadMessages)
	if errors.Is(err, rooms.ErrNotFound) {
		return api.Knock404JSONResponse{RoomNotFoundJSONResponse: roomNotFound}, nil
	}
	if err != nil {
		return nil, err
	}
	if !s.inVoice(req.Id, caller.ID) {
		return api.Knock409JSONResponse{Code: "not_in_voice", Message: "join this room's voice before knocking"}, nil
	}
	if wait := s.knocks.pair.Take(caller.ID + " " + req.Body.VisitorId); wait > 0 {
		return knockTooSoon(wait), nil
	}
	if wait := s.knocks.caller.Take(caller.ID); wait > 0 {
		return knockTooSoon(wait), nil
	}
	// Someone already in this voice, offline or unknown gets nothing, and the
	// caller cannot tell which.
	if !s.inVoice(req.Id, req.Body.VisitorId) {
		s.events.Knocked(req.Body.VisitorId, req.Id, caller)
	}
	return api.Knock204Response{}, nil
}

func (s *server) inVoice(roomID, visitorID string) bool {
	if s.voice == nil {
		return false
	}
	for _, o := range s.voice.Occupancy(roomID) {
		if o.ID == visitorID {
			return true
		}
	}
	return false
}

func knockTooSoon(wait time.Duration) api.Knock429JSONResponse {
	return api.Knock429JSONResponse{
		Body:    api.Error{Code: "knock_too_soon", Message: "knocked too often; try again later"},
		Headers: api.Knock429ResponseHeaders{RetryAfter: int(math.Ceil(wait.Seconds()))},
	}
}
