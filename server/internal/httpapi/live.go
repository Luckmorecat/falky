package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/rooms"
)

// live serves GET /api/live, which the contract describes but the generated
// server leaves out: it checks the Origin, the visitor cookie and that the
// visitor may connect, then hands the connection to the hub.
type live struct {
	origin   string
	resolve  visitorResolver
	identity *identity.Service
	rooms    *rooms.Service
	hub      *realtime.Hub
	logger   *slog.Logger
}

func (l live) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Origin"), l.origin) {
		writeError(w, http.StatusForbidden, "origin_forbidden", "live updates are only for pages of this server's origin")
		return
	}
	visitor, ok := l.resolve.visitor(w, r)
	if !ok {
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		writeError(w, http.StatusBadRequest, "invalid_request", "not a WebSocket upgrade")
		return
	}
	disconnect, err := l.identity.Connect(r.Context(), visitor.ID)
	if errors.Is(err, identity.ErrNameTaken) {
		writeError(w, http.StatusConflict, yourNameTaken.Code, yourNameTaken.Message)
		return
	}
	if err != nil {
		errorWriter{logger: l.logger}.internal(w, r, err)
		return
	}
	opened := false
	defer func() { disconnect(opened) }()
	opened = l.hub.Serve(w, r, realtime.Subscriber{
		VisitorID: visitor.ID,
		MayReceive: func(ctx context.Context, roomID string) bool {
			err := l.rooms.Authorize(ctx, visitor, roomID, rooms.ReadMessages)
			if err != nil && !errors.Is(err, rooms.ErrNotFound) && ctx.Err() == nil {
				l.logger.ErrorContext(ctx, "live update not sent", "visitor", visitor.ID, "room", roomID, "error", err)
			}
			return err == nil
		},
	})
}

// Events encodes what the modules report as the contract's events and
// publishes them on Hub. Its methods are the modules' publishers.
type Events struct {
	Hub    *realtime.Hub
	Logger *slog.Logger
}

// MessageCreated publishes message.created for m, to the visitors allowed
// into m's room.
func (e Events) MessageCreated(m chat.Message) {
	e.publish(api.EventTypeMessageCreated, m.RoomID, func(p *api.Event_Payload) error {
		return p.FromMessage(messageBody(m))
	})
}

// RoomChanged publishes room.changed for r, to every visitor.
func (e Events) RoomChanged(r rooms.Room) {
	e.publish(api.EventTypeRoomChanged, "", func(p *api.Event_Payload) error {
		return p.FromRoomChange(api.RoomChange{Id: r.ID, Name: r.Name})
	})
}

// publish publishes an event of type typ whose payload setPayload fills in;
// roomID is the room the event is about, if it is about what happens inside
// one.
func (e Events) publish(typ api.EventType, roomID string, setPayload func(*api.Event_Payload) error) {
	event := api.Event{
		V:         api.EventVN1,
		Type:      typ,
		EventId:   ulid.Make().String(),
		RoomId:    roomID,
		Timestamp: time.Now().UTC().Truncate(time.Millisecond),
	}
	err := setPayload(&event.Payload)
	var data []byte
	if err == nil {
		data, err = json.Marshal(event)
	}
	if err != nil {
		e.Logger.Error("live update not published", "type", typ, "error", err)
		return
	}
	e.Hub.Publish(realtime.Event{RoomID: roomID, Data: data})
}
