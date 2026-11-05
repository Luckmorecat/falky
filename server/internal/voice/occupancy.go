package voice

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/rooms"
)

// RefreshInterval is how often Run refreshes the view from LiveKit's
// participant listing, which corrects it after a lost webhook.
const RefreshInterval = 30 * time.Second

// ErrUnverifiedWebhook reports a webhook request that does not carry a valid
// signature of its body with the LiveKit API key; the wrapping error says
// why.
var ErrUnverifiedWebhook = errors.New("webhook not signed with the LiveKit API key")

// ErrInvalidWebhook reports a signed webhook request whose body is not a
// LiveKit event.
var ErrInvalidWebhook = errors.New("webhook is not a LiveKit event")

// Occupancy returns the participants of the room roomID's voice, each visitor
// once, ordered by name.
func (s *Service) Occupancy(roomID string) []identity.Visitor {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.occupancyLocked(roomID)
}

// occupancyLocked is Occupancy for a caller that holds s.mu.
func (s *Service) occupancyLocked(roomID string) []identity.Visitor {
	var occupancy []identity.Visitor
	for _, v := range s.view[roomID] {
		if !slices.ContainsFunc(occupancy, func(o identity.Visitor) bool { return o.ID == v.ID }) {
			occupancy = append(occupancy, v)
		}
	}
	slices.SortFunc(occupancy, func(a, b identity.Visitor) int {
		return cmp.Or(strings.Compare(identity.NameKey(a.Name), identity.NameKey(b.Name)), strings.Compare(a.ID, b.ID))
	})
	return occupancy
}

// ReceiveWebhook verifies that the webhook request r is signed with the
// LiveKit API key and applies the event it carries to the view: a participant
// joined (kept only if they may stay, otherwise removed from that room's
// voice), left or failed to connect, or a room's voice closed. Other events
// change nothing, and an event applied again changes nothing more.
//
// It fails with ErrUnverifiedWebhook or ErrInvalidWebhook, changing nothing,
// or with an error from checking or removing the participant, after which
// LiveKit sends the event again.
func (s *Service) ReceiveWebhook(r *http.Request) error {
	body, err := webhook.Receive(r, s.keys)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnverifiedWebhook, err)
	}
	var event livekit.WebhookEvent
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(body, &event); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidWebhook, err)
	}
	return s.apply(r.Context(), &event)
}

// apply applies event to the view, checking a participant who joined.
func (s *Service) apply(ctx context.Context, event *livekit.WebhookEvent) error {
	room := event.GetRoom().GetName()
	p := Participant{Room: room, Identity: event.GetParticipant().GetIdentity(), SID: event.GetParticipant().GetSid()}
	s.publishing.Lock()
	defer s.publishing.Unlock()
	switch event.GetEvent() {
	case webhook.EventParticipantJoined:
		v, ok, err := s.keepOrRemove(ctx, p)
		if err != nil {
			return err
		}
		s.change(func() {
			if ok {
				put(s.view, p, v)
			} else {
				drop(s.view, p)
			}
		}, room)
	case webhook.EventParticipantLeft, webhook.EventParticipantConnectionAborted:
		s.change(func() { drop(s.view, p) }, room)
	case webhook.EventRoomFinished:
		s.change(func() { delete(s.view, room) }, room)
	}
	return nil
}

// Refresh replaces the view with LiveKit's listing of every room's
// participants, removing each participant who may not stay from that room's
// voice, and publishes the occupancy of each room it changed. It fails with
// an ErrUnavailable or an error from checking a participant, leaving the
// view as it was.
func (s *Service) Refresh(ctx context.Context) (err error) {
	defer func() {
		if !errors.Is(ctx.Err(), context.Canceled) {
			s.refreshLog.Report(ctx, s.logger, "voice occupancy refresh", err)
		}
	}()
	s.publishing.Lock()
	defer s.publishing.Unlock()
	listed, err := s.livekit.Participants(ctx)
	if err != nil {
		return fmt.Errorf("%w: list participants: %w", ErrUnavailable, err)
	}
	view := make(map[string]map[string]identity.Visitor)
	for _, p := range listed {
		v, ok, err := s.keepOrRemove(ctx, p)
		if err != nil {
			return err
		}
		if ok {
			put(view, p, v)
		}
	}
	// Only changes under s.publishing write the view, so it holds still.
	s.mu.Lock()
	roomIDs := slices.AppendSeq(slices.Collect(maps.Keys(s.view)), maps.Keys(view))
	s.mu.Unlock()
	slices.Sort(roomIDs)
	s.change(func() { s.view = view }, slices.Compact(roomIDs)...)
	return nil
}

// RemoveAll removes every participant from every room's voice, empties the
// view and publishes the occupancy of each room that had participants. It
// fails with an ErrUnavailable, leaving the view as it was.
func (s *Service) RemoveAll(ctx context.Context) error {
	s.publishing.Lock()
	defer s.publishing.Unlock()
	if err := s.livekit.RemoveAll(ctx); err != nil {
		return fmt.Errorf("%w: remove every participant: %w", ErrUnavailable, err)
	}
	s.logger.InfoContext(ctx, "every participant removed from voice")
	// Only changes under s.publishing write the view, so it holds still.
	s.mu.Lock()
	roomIDs := slices.Sorted(maps.Keys(s.view))
	s.mu.Unlock()
	s.change(func() { clear(s.view) }, roomIDs...)
	return nil
}

// Run refreshes the view at once, as the server starts, and then every
// RefreshInterval until ctx is done. It logs a refresh that fails and leaves
// it to the next.
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(RefreshInterval)
	defer ticker.Stop()
	for {
		refreshCtx, cancel := context.WithTimeout(ctx, RefreshInterval)
		_ = s.Refresh(refreshCtx)
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// keepOrRemove reports whether the participant p may stay in their room's voice and
// removes them from it when not. They may while they are a visitor with
// current access whom rooms lets join the room's voice and, if the server
// issued them a token since it started, the last one was for this room. It
// returns the visitor, under their current name, when they may.
func (s *Service) keepOrRemove(ctx context.Context, p Participant) (identity.Visitor, bool, error) {
	v, refusal, err := s.mayStay(ctx, p)
	if err != nil {
		return identity.Visitor{}, false, err
	}
	if refusal == "" {
		return v, true, nil
	}
	if err := s.livekit.RemoveParticipant(ctx, p.Room, p.Identity); err != nil {
		return identity.Visitor{}, false, fmt.Errorf("%w: remove from room %s: %w", ErrUnavailable, p.Room, err)
	}
	s.logger.InfoContext(ctx, "participant removed from voice", "room", p.Room, "visitor", p.Identity, "reason", refusal)
	return identity.Visitor{}, false, nil
}

// mayStay returns the visitor p is when they may stay in their room's voice,
// and otherwise why not.
func (s *Service) mayStay(ctx context.Context, p Participant) (v identity.Visitor, refusal string, err error) {
	v, err = s.visitors.Visitor(ctx, p.Identity)
	if errors.Is(err, identity.ErrNoVisitor) {
		return identity.Visitor{}, "no current access", nil
	}
	if err != nil {
		return identity.Visitor{}, "", err
	}
	err = s.rooms.Authorize(ctx, v, p.Room, rooms.JoinVoice)
	switch {
	case errors.Is(err, rooms.ErrNotFound):
		return identity.Visitor{}, "no such room", nil
	case errors.Is(err, identity.ErrNameTaken):
		return identity.Visitor{}, "name taken", nil
	case err != nil:
		return identity.Visitor{}, "", err
	}
	if room, ok := s.IssuedRoom(v.ID); ok && room != p.Room {
		return identity.Visitor{}, "issued another room", nil
	}
	return v, "", nil
}

// put adds the participant p, who is the visitor v, to view.
func put(view map[string]map[string]identity.Visitor, p Participant, v identity.Visitor) {
	if view[p.Room] == nil {
		view[p.Room] = make(map[string]identity.Visitor)
	}
	view[p.Room][p.SID] = v
}

// drop removes the participant p from view.
func drop(view map[string]map[string]identity.Visitor, p Participant) {
	delete(view[p.Room], p.SID)
	if len(view[p.Room]) == 0 {
		delete(view, p.Room)
	}
}

// change applies apply to the view under s.mu, then publishes the occupancy
// of each of roomIDs that it changed. The caller holds s.publishing, so changes
// publish in the order they apply.
func (s *Service) change(apply func(), roomIDs ...string) {
	s.mu.Lock()
	before := make([][]identity.Visitor, len(roomIDs))
	for i, id := range roomIDs {
		before[i] = s.occupancyLocked(id)
	}
	apply()
	after := make([][]identity.Visitor, len(roomIDs))
	for i, id := range roomIDs {
		after[i] = s.occupancyLocked(id)
	}
	s.mu.Unlock()
	for i, id := range roomIDs {
		if !slices.Equal(before[i], after[i]) {
			s.publish(id, after[i])
		}
	}
}
