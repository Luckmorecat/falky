package voice

import (
	"context"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/rooms"
)

// Signalling must require session validation before using the identity-lookup
// fallback supported by maintenance and occupancy.
func (s *Service) authorizeGrant(ctx context.Context, g *voiceGrant) (identity.Visitor, error) {
	var visitor identity.Visitor
	var err error
	if s.validate != nil {
		var current identity.Session
		current, err = s.validate(ctx, g.session)
		visitor = current.Visitor
	} else {
		visitor, err = s.visitors.Visitor(ctx, g.session.Visitor.ID)
	}
	if err != nil {
		return identity.Visitor{}, err
	}
	return visitor, s.rooms.Authorize(ctx, visitor, g.room, rooms.JoinVoice)
}
