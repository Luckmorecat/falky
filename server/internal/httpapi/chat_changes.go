package httpapi

import (
	"context"
	"errors"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/rooms"
)

// changeOutcome is how a message change ended, for each operation to answer in
// its own response types.
type changeOutcome struct {
	message chat.Message
	status  int
	body    api.Error
}

// changeMessage checks that the visitor may post in the room and applies
// change; an outcome with status 0 is a success.
func (s *server) changeMessage(ctx context.Context, roomID string, change func() (chat.Message, error)) (changeOutcome, error) {
	err := s.rooms.Authorize(ctx, currentVisitor(ctx), roomID, rooms.PostMessage)
	if errors.Is(err, rooms.ErrNotFound) {
		return changeOutcome{status: 404, body: api.Error(roomNotFound)}, nil
	}
	if err != nil {
		return changeOutcome{}, err
	}
	m, err := change()
	switch {
	case errors.Is(err, chat.ErrNotFound):
		return changeOutcome{status: 404, body: api.Error{Code: "message_not_found", Message: err.Error()}}, nil
	case errors.Is(err, chat.ErrNotAuthor):
		return changeOutcome{status: 403, body: api.Error{Code: "not_author", Message: err.Error()}}, nil
	case errors.Is(err, chat.ErrDeleted):
		return changeOutcome{status: 409, body: api.Error{Code: "message_deleted", Message: err.Error()}}, nil
	case errors.Is(err, chat.ErrInvalidBody):
		return changeOutcome{status: 400, body: api.Error{Code: "invalid_message", Message: err.Error()}}, nil
	case errors.Is(err, chat.ErrInvalidReaction):
		return changeOutcome{status: 400, body: api.Error{Code: "invalid_request", Message: err.Error()}}, nil
	case errors.Is(err, chat.ErrRateLimited):
		return changeOutcome{status: 429, body: api.Error{Code: "rate_limited", Message: "too many reaction changes; try again later"}}, nil
	case err != nil:
		return changeOutcome{}, err
	}
	return changeOutcome{message: m}, nil
}

func (s *server) EditMessage(ctx context.Context, req api.EditMessageRequestObject) (api.EditMessageResponseObject, error) {
	if req.Body == nil {
		return api.EditMessage400JSONResponse{Code: "invalid_request", Message: "a body is required"}, nil
	}
	out, err := s.changeMessage(ctx, req.Id, func() (chat.Message, error) {
		return s.chat.Edit(ctx, currentVisitor(ctx), req.Id, req.MessageId, req.Body.Body)
	})
	switch {
	case err != nil:
		return nil, err
	case out.status == 400:
		return api.EditMessage400JSONResponse(out.body), nil
	case out.status == 403:
		return api.EditMessage403JSONResponse(out.body), nil
	case out.status == 404:
		return api.EditMessage404JSONResponse(out.body), nil
	case out.status == 409:
		return api.EditMessage409JSONResponse(out.body), nil
	case out.status != 0:
		return nil, errors.New(out.body.Message)
	}
	return api.EditMessage200JSONResponse(messageBody(out.message)), nil
}

func (s *server) DeleteMessage(ctx context.Context, req api.DeleteMessageRequestObject) (api.DeleteMessageResponseObject, error) {
	out, err := s.changeMessage(ctx, req.Id, func() (chat.Message, error) {
		return s.chat.Delete(ctx, currentVisitor(ctx), req.Id, req.MessageId)
	})
	switch {
	case err != nil:
		return nil, err
	case out.status == 403:
		return api.DeleteMessage403JSONResponse(out.body), nil
	case out.status == 404:
		return api.DeleteMessage404JSONResponse(out.body), nil
	case out.status != 0:
		return nil, errors.New(out.body.Message)
	}
	return api.DeleteMessage200JSONResponse(messageBody(out.message)), nil
}

func (s *server) AddReaction(ctx context.Context, req api.AddReactionRequestObject) (api.AddReactionResponseObject, error) {
	out, err := s.changeMessage(ctx, req.Id, func() (chat.Message, error) {
		return s.chat.React(ctx, currentVisitor(ctx), req.Id, req.MessageId, string(req.Reaction), true)
	})
	switch {
	case err != nil:
		return nil, err
	case out.status == 400:
		return api.AddReaction400JSONResponse(out.body), nil
	case out.status == 404:
		return api.AddReaction404JSONResponse(out.body), nil
	case out.status == 409:
		return api.AddReaction409JSONResponse(out.body), nil
	case out.status == 429:
		return api.AddReaction429JSONResponse(out.body), nil
	case out.status != 0:
		return nil, errors.New(out.body.Message)
	}
	return api.AddReaction200JSONResponse(messageBody(out.message)), nil
}

func (s *server) RemoveReaction(ctx context.Context, req api.RemoveReactionRequestObject) (api.RemoveReactionResponseObject, error) {
	out, err := s.changeMessage(ctx, req.Id, func() (chat.Message, error) {
		return s.chat.React(ctx, currentVisitor(ctx), req.Id, req.MessageId, string(req.Reaction), false)
	})
	switch {
	case err != nil:
		return nil, err
	case out.status == 400:
		return api.RemoveReaction400JSONResponse(out.body), nil
	case out.status == 404:
		return api.RemoveReaction404JSONResponse(out.body), nil
	case out.status == 429:
		return api.RemoveReaction429JSONResponse(out.body), nil
	case out.status != 0:
		return nil, errors.New(out.body.Message)
	}
	return api.RemoveReaction200JSONResponse(messageBody(out.message)), nil
}
