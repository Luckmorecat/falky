package httpapi

import (
	"context"
	"errors"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/attachments"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/rooms"
)

func (s *server) ListMessages(ctx context.Context, req api.ListMessagesRequestObject) (api.ListMessagesResponseObject, error) {
	err := s.rooms.Authorize(ctx, currentVisitor(ctx), req.Id, rooms.ReadMessages)
	if errors.Is(err, rooms.ErrNotFound) {
		return api.ListMessages404JSONResponse{RoomNotFoundJSONResponse: roomNotFound}, nil
	}
	if err != nil {
		return nil, err
	}
	page := chat.Page{Before: req.Params.Before, After: req.Params.After, Limit: chat.DefaultLimit}
	if req.Params.Limit != nil {
		page.Limit = *req.Params.Limit
	}
	list, err := s.chat.History(ctx, req.Id, page)
	if errors.Is(err, chat.ErrInvalidPage) {
		return api.ListMessages400JSONResponse{Code: "invalid_request", Message: err.Error()}, nil
	}
	if err != nil {
		return nil, err
	}
	body := api.MessageList{Messages: make([]api.Message, 0, len(list))}
	for _, m := range list {
		body.Messages = append(body.Messages, messageBody(m))
	}
	return api.ListMessages200JSONResponse(body), nil
}

func (s *server) PostMessage(ctx context.Context, req api.PostMessageRequestObject) (api.PostMessageResponseObject, error) {
	visitor := currentVisitor(ctx)
	err := s.rooms.Authorize(ctx, visitor, req.Id, rooms.PostMessage)
	if errors.Is(err, rooms.ErrNotFound) {
		return api.PostMessage404JSONResponse{RoomNotFoundJSONResponse: roomNotFound}, nil
	}
	if err != nil {
		return nil, err
	}
	m, created, err := s.chat.Post(ctx, visitor, req.Id, req.Body.RequestKey, req.Body.Body, req.Body.AttachmentIds...)
	switch {
	case errors.Is(err, attachments.ErrInvalidAttachments):
		_, body, _ := attachmentError(err)
		return api.PostMessage400JSONResponse(body), nil
	case errors.Is(err, attachments.ErrQuota), errors.Is(err, attachments.ErrCleanupPending), errors.Is(err, attachments.ErrClosed):
		_, body, _ := attachmentError(err)
		return api.PostMessage503JSONResponse(body), nil
	case errors.Is(err, chat.ErrInvalidBody):
		return api.PostMessage400JSONResponse{Code: "invalid_message", Message: err.Error()}, nil
	case errors.Is(err, chat.ErrInvalidRequestKey):
		return api.PostMessage400JSONResponse{Code: "invalid_request", Message: err.Error()}, nil
	case errors.Is(err, chat.ErrRequestKeyReused):
		return api.PostMessage409JSONResponse{Code: "request_key_reused", Message: err.Error()}, nil
	case errors.Is(err, chat.ErrRateLimited):
		return api.PostMessage429JSONResponse{Code: "rate_limited", Message: "too many messages; try again later"}, nil
	case err != nil:
		return nil, err
	case created:
		return api.PostMessage201JSONResponse(messageBody(m)), nil
	}
	return api.PostMessage200JSONResponse(messageBody(m)), nil
}

// roomNotFound is the answer to a request about a room that does not exist.
var roomNotFound = api.RoomNotFoundJSONResponse{Code: "room_not_found", Message: "no such room"}

func messageBody(m chat.Message) api.Message {
	attached := make([]api.Attachment, 0, len(m.Attachments))
	for _, metadata := range m.Attachments {
		attached = append(attached, attachmentBody(metadata))
	}
	return api.Message{
		Attachments: attached,
		Id:          m.ID,
		RoomId:      m.RoomID,
		AuthorId:    m.AuthorID,
		AuthorName:  m.AuthorName,
		Body:        m.Body,
		CreatedAt:   m.CreatedAt,
	}
}
