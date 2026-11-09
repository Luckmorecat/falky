package httpapi

import (
	"context"
	"errors"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
)

func (s *server) JoinVoice(ctx context.Context, req api.JoinVoiceRequestObject) (api.JoinVoiceResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if currentSession(ctx).Kind == identity.Account {
		r, _ := accountHTTP(ctx)
		if r.Header.Get("Origin") != s.publicOrigin {
			return api.JoinVoice403JSONResponse{Code: "origin_forbidden", Message: "account voice requires this server's exact origin"}, nil
		}
	}
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	session, err := s.identity.ValidateSession(ctx, currentSession(ctx))
	if errors.Is(err, identity.ErrNoVisitor) {
		return api.JoinVoice401JSONResponse{VisitorRequiredJSONResponse: visitorRequired}, nil
	}
	if err != nil {
		return nil, err
	}
	visitor := session.Visitor
	err = s.rooms.Authorize(ctx, visitor, req.Id, rooms.JoinVoice)
	if errors.Is(err, rooms.ErrNotFound) {
		return api.JoinVoice404JSONResponse{RoomNotFoundJSONResponse: roomNotFound}, nil
	}
	if errors.Is(err, identity.ErrNameTaken) {
		return api.JoinVoice409JSONResponse(yourNameTaken), nil
	}
	if err != nil {
		return nil, err
	}
	confirm := req.Body != nil && req.Body.ConfirmTransfer
	creds, err := s.voice.JoinSession(ctx, session, req.Id, confirm)
	switch {
	case errors.Is(err, voice.ErrTransferRequired):
		return api.JoinVoice409JSONResponse{Code: "voice_transfer_required", Message: err.Error()}, nil
	case errors.Is(err, voice.ErrRoomFull):
		return api.JoinVoice409JSONResponse{Code: "room_full", Message: err.Error()}, nil
	case errors.Is(err, voice.ErrUnavailable):
		s.logger.WarnContext(ctx, "voice join failed", "room", req.Id, "error", err)
		return api.JoinVoice503JSONResponse{Code: "voice_unavailable", Message: "voice is unavailable; try again later"}, nil
	case err != nil:
		return nil, err
	}
	return api.JoinVoice200JSONResponse{Url: creds.URL, Token: creds.Token, GrantId: creds.GrantID}, nil
}

func (s *server) LeaveVoice(ctx context.Context, req api.LeaveVoiceRequestObject) (api.LeaveVoiceResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if currentSession(ctx).Kind == identity.Account {
		r, _ := accountHTTP(ctx)
		if r.Header.Get("Origin") != s.publicOrigin {
			return api.LeaveVoice403JSONResponse{Code: "origin_forbidden", Message: "account voice requires this server's exact origin"}, nil
		}
	}
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	session, err := s.identity.ValidateSession(ctx, currentSession(ctx))
	if errors.Is(err, identity.ErrNoVisitor) {
		return api.LeaveVoice401JSONResponse{VisitorRequiredJSONResponse: visitorRequired}, nil
	}
	if err != nil {
		return nil, err
	}
	if req.Body == nil || req.Body.GrantId == "" {
		return api.LeaveVoice400JSONResponse{Code: "bad_request", Message: "missing voice grant"}, nil
	}
	err = s.voice.Leave(ctx, session, req.Body.GrantId)
	if errors.Is(err, identity.ErrNoVisitor) {
		return api.LeaveVoice403JSONResponse{Code: "grant_forbidden", Message: "voice grant belongs to another session"}, nil
	}
	if err != nil {
		return nil, err
	}
	return api.LeaveVoice200JSONResponse{Revoked: true}, nil
}
