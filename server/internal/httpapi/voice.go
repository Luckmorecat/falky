package httpapi

import (
	"context"
	"errors"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
)

func (s *server) JoinVoice(ctx context.Context, req api.JoinVoiceRequestObject) (api.JoinVoiceResponseObject, error) {
	visitor := currentVisitor(ctx)
	err := s.rooms.Authorize(ctx, visitor, req.Id, rooms.JoinVoice)
	if errors.Is(err, rooms.ErrNotFound) {
		return api.JoinVoice404JSONResponse{RoomNotFoundJSONResponse: roomNotFound}, nil
	}
	if err != nil {
		return nil, err
	}
	creds, err := s.voice.Join(ctx, visitor, req.Id)
	switch {
	case errors.Is(err, voice.ErrRoomFull):
		return api.JoinVoice409JSONResponse{Code: "room_full", Message: err.Error()}, nil
	case errors.Is(err, voice.ErrUnavailable):
		s.logger.WarnContext(ctx, "voice join failed", "room", req.Id, "error", err)
		return api.JoinVoice503JSONResponse{Code: "voice_unavailable", Message: "voice is unavailable; try again later"}, nil
	case err != nil:
		return nil, err
	}
	return api.JoinVoice200JSONResponse{Url: creds.URL, Token: creds.Token}, nil
}
