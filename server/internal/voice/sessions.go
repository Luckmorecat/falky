package voice

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

type voiceGrant struct {
	session         identity.Session
	transport, room string
	revoked         bool
	sockets         map[*signalConnection]struct{}
	expiry          *time.Timer
}

// ConfigureAdmission must run before serving. One gate protects identity
// mutations, token issuance, and the complete signalling handshake.
func (s *Service) ConfigureAdmission(gate sync.Locker, validate func(context.Context, identity.Session) (identity.Session, error), publicOrigin string) {
	s.admission, s.validate = gate, validate
	s.guardedURL = "ws" + strings.TrimPrefix(publicOrigin, "http")
}

func (s *Service) logicalIdentity(transport string) string {
	// Identity IDs never contain dots. Account grants append an opaque nonce;
	// metadata and attributes remain freely editable and carry no authority.
	id, _, _ := strings.Cut(transport, ".")
	return id
}

func (s *Service) fence(g *voiceGrant) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g.revoked = true
	if g.expiry != nil {
		g.expiry.Stop()
	}
}

func (s *Service) closeGrant(ctx context.Context, g *voiceGrant) {
	s.mu.Lock()
	var sockets []*signalConnection
	for socket := range g.sockets {
		sockets = append(sockets, socket)
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	for _, socket := range sockets {
		socket.revoke(ctx)
	}
}

func (s *Service) retire(g *voiceGrant) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.grants[g.transport] == g {
		delete(s.grants, g.transport)
		if s.current[g.session.Visitor.ID] == g.transport {
			delete(s.current, g.session.Visitor.ID)
		}
	}
}

// Revoke fences matching grants before removing their media participants.
// Failed removals are returned; their grants remain fenced for retry.
func (s *Service) Revoke(ctx context.Context, matches func(identity.Session) bool) error {
	s.mu.Lock()
	var matched []*voiceGrant
	for _, g := range s.grants {
		if matches(g.session) {
			matched = append(matched, g)
		}
	}
	s.mu.Unlock()
	for _, g := range matched {
		s.fence(g)
	}
	var err error
	for _, g := range matched {
		removeErr := s.livekit.RemoveParticipant(ctx, g.room, g.transport)
		s.closeGrant(ctx, g)
		err = errors.Join(err, removeErr)
		if removeErr == nil {
			s.retire(g)
		}
	}
	return err
}

func (s *Service) expireAt(g *voiceGrant) {
	if s.admission == nil {
		return
	}
	g.expiry = time.AfterFunc(time.Until(g.session.ExpiresAt), func() {
		s.admission.Lock()
		defer s.admission.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.Revoke(ctx, func(other identity.Session) bool { return other.ID == g.session.ID }); err != nil {
			s.logger.ErrorContext(ctx, "expired voice session removal failed", "error", err)
		} else if err := s.Refresh(ctx); err != nil {
			s.logger.ErrorContext(ctx, "expired voice occupancy refresh failed", "error", err)
		}
	})
}

// CloseSignalling ends all proxied sockets during server shutdown.
func (s *Service) CloseSignalling() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, g := range s.grants {
		if g.expiry != nil {
			g.expiry.Stop()
		}
		for socket := range g.sockets {
			socket.close()
		}
	}
}
